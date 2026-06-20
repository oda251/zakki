import { eq } from "drizzle-orm";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, embeddings } from "@zakki/data/db/schema.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { bufferToVector, vectorToBuffer } from "./vector.ts";

function contentHash(content: string): string {
  return Bun.hash(content).toString(16);
}

/**
 * 全チャンクの埋め込みを最新化する（content ハッシュで差分検知）。
 * embed は非同期・バッチ。削除されたチャンクの行は FK cascade で消える。
 */
export async function syncChunkEmbeddings(
  db: Db,
  embedder: Embedder,
): Promise<Result<{ embedded: number }, DbError>> {
  const stale = await tryDbAsync(async () => {
    const rows = await db
      .select({
        id: chunks.id,
        content: chunks.content,
        hash: embeddings.contentHash,
      })
      .from(chunks)
      .leftJoin(embeddings, eq(chunks.id, embeddings.chunkId));
    return rows.filter((r) => r.hash !== contentHash(r.content));
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
        const hash = contentHash(row.content);
        const buf = vectorToBuffer(vector);
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
  return tryDbAsync(async () => {
    const rows = await db.select().from(embeddings);
    return new Map(rows.map((r) => [r.chunkId, bufferToVector(r.vector)]));
  });
}
