import { eq, isNull } from "drizzle-orm";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import { AAD } from "@zakki/core/crypto/aad.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, embeddings } from "@zakki/data/db/schema.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import { contentHash64 } from "@zakki/core/util/hash.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { bufferToVector, vectorToBuffer } from "./vector.ts";

/**
 * content の変化検知ハッシュ。暗号 ON は鍵付き（平文を保存しない）、OFF は
 * ランタイム非依存の FNV-1a（CF Workers に Bun.hash が無いため。旧 Bun.hash 値の
 * 既存行は不一致となり初回だけ再埋め込みされるが、値は content から再導出できる）
 */
function contentHash(crypto: CryptoContext | undefined, content: string): string {
  return crypto === undefined ? contentHash64(content) : crypto.contentHash(content);
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
      .leftJoin(embeddings, eq(chunks.id, embeddings.chunkId))
      // 日付チャンク（構造ノード, content = 日付）は埋め込まない: 日付同士の
      // 見かけの類似で無意味なリンクが張られるのを防ぐ
      .where(isNull(chunks.date));
    // content は暗号 ON では暗号文。復号した平文で hash 比較・embed する。
    const decrypted = rows.map((r) => ({
      id: r.id,
      content: crypto === undefined ? r.content : crypto.decString(r.content, AAD.chunkContent),
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
            : Buffer.from(crypto.encVector(vector, AAD.embeddingVector));
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
              AAD.embeddingVector,
            ),
      ]),
    );
  });
}
