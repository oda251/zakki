import { eq } from "drizzle-orm";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, embeddings } from "@zakki/data/db/schema.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { bufferToVector, vectorToBuffer } from "./vector.ts";

/** content の変化検知ハッシュ。暗号 ON は鍵付き（平文を保存しない）、OFF は従来の Bun.hash */
function contentHash(crypto: CryptoContext | undefined, content: string): string {
  return crypto === undefined ? Bun.hash(content).toString(16) : crypto.contentHash(content);
}

/**
 * 全チャンクの埋め込みを最新化する（content ハッシュで差分検知）。
 * embed は非同期・バッチ。削除されたチャンクの行は FK cascade で消える。
 */
export async function syncChunkEmbeddings(
  db: Db,
  embedder: Embedder,
): Promise<Result<{ embedded: number }, DbError>> {
  const crypto = getCrypto(db);
  const stale = await tryDbAsync(async () => {
    const rows = await db
      .select({
        id: chunks.id,
        content: chunks.content,
        hash: embeddings.contentHash,
      })
      .from(chunks)
      .leftJoin(embeddings, eq(chunks.id, embeddings.chunkId));
    // content は暗号 ON では暗号文。復号した平文で hash 比較・embed する。
    const decrypted = rows.map((r) => ({
      id: r.id,
      content: crypto === undefined ? r.content : crypto.decString(r.content, "chunk.content"),
      hash: r.hash,
    }));
    return decrypted.filter((r) => r.hash !== contentHash(crypto, r.content));
  });
  if (stale.isErr()) {
    return err(stale.error);
  }
  if (stale.value.length === 0) {
    return ok({ embedded: 0 });
  }

  let vectors: Float32Array[];
  try {
    vectors = await embedder.embed(stale.value.map((r) => r.content));
  } catch (cause) {
    return err({ type: "db-error", message: errorMessage(cause), cause });
  }

  const now = new Date().toISOString();
  const staleRows = stale.value;
  return tryDbAsync(async () => {
    await db.transaction(async (tx) => {
      for (const [i, row] of staleRows.entries()) {
        const vector = vectors[i];
        if (vector === undefined) {
          continue;
        }
        const hash = contentHash(crypto, row.content);
        const buf =
          crypto === undefined
            ? vectorToBuffer(vector)
            : Buffer.from(crypto.encVector(vector, "embedding.vector"));
        await tx
          .insert(embeddings)
          .values({
            chunkId: row.id,
            contentHash: hash,
            model: embedder.name,
            vector: buf,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: embeddings.chunkId,
            set: {
              contentHash: hash,
              model: embedder.name,
              vector: buf,
              updatedAt: now,
            },
          });
      }
    });
    return { embedded: staleRows.length };
  });
}

/** chunk id → 正規化済みベクトル */
export function loadVectors(db: Db): ResultAsync<Map<number, Float32Array>, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const rows = await db.select().from(embeddings);
    return new Map(
      rows.map((r) => [
        r.chunkId,
        crypto === undefined
          ? bufferToVector(r.vector)
          : crypto.decVector(
              new Uint8Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength),
              "embedding.vector",
            ),
      ]),
    );
  });
}
