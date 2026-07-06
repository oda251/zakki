import type { Db } from "@zakki/data/db/client.ts";
import type { Chunk } from "@zakki/data/db/schema.ts";
import { getOrCreateDateChunk, saveChildren } from "@zakki/data/chunk/repository.ts";

/**
 * テスト用シード: 日付チャンクを用意し、その子として本文チャンク列を保存する。
 * 旧 saveSnapshot ベースのテストの置き換え先（プロダクションコードでは使わない）。
 */
export async function seedDayChunks(
  db: Db,
  date: string,
  contents: readonly string[],
): Promise<{ root: Chunk; chunks: Chunk[] }> {
  const root = (await getOrCreateDateChunk(db, date))._unsafeUnwrap();
  const chunks = (
    await saveChildren(
      db,
      root.id,
      contents.map((content) => ({ content })),
    )
  )._unsafeUnwrap();
  return { root, chunks };
}
