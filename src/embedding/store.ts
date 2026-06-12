import { eq } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import type { Db } from "@/db/client.ts";
import type { DbError } from "@/db/error.ts";
import { tryDb } from "@/db/error.ts";
import { chunks, embeddings } from "@/db/schema.ts";
import type { Embedder } from "./embedder.ts";
import { bufferToVector, vectorToBuffer } from "./embedder.ts";

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
  const stale = tryDb(() => {
    const rows = db
      .select({
        id: chunks.id,
        content: chunks.content,
        hash: embeddings.contentHash,
      })
      .from(chunks)
      .leftJoin(embeddings, eq(chunks.id, embeddings.chunkId))
      .all();
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
    return err({
      type: "db-error",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const now = new Date().toISOString();
  return tryDb(() => {
    db.transaction((tx) => {
      stale.value.forEach((row, i) => {
        const vector = vectors[i];
        if (vector === undefined) {
          return;
        }
        tx.insert(embeddings)
          .values({
            chunkId: row.id,
            contentHash: contentHash(row.content),
            model: embedder.name,
            vector: vectorToBuffer(vector),
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: embeddings.chunkId,
            set: {
              contentHash: contentHash(row.content),
              model: embedder.name,
              vector: vectorToBuffer(vector),
              updatedAt: now,
            },
          })
          .run();
      });
    });
    return { embedded: stale.value.length };
  });
}

/** chunk id → 正規化済みベクトル */
export function loadVectors(db: Db): Result<Map<number, Float32Array>, DbError> {
  return tryDb(() => {
    const rows = db.select().from(embeddings).all();
    return new Map(rows.map((r) => [r.chunkId, bufferToVector(r.vector)]));
  });
}
