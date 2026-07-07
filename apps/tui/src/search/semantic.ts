import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { nearestChunks } from "@zakki/data/embedding/semantic.ts";
import { loadVectors } from "@zakki/data/embedding/store.ts";
import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import { convertRomaji } from "@zakki/core/romaji/convert.ts";

/**
 * セマンティック検索（docs/FEATURES.md 候補8）。ローマ字クエリをかな→漢字に開いてから
 * 埋め込み、近傍チャンクを返す。かな文の埋め込みは弱い（実測）ため漢字へ変換して投入する。
 * byId は検索ペインを開いた時点のチャンク索引（id → チャンク）。
 */
export async function searchSemantic(
  query: string,
  engine: KanaKanjiEngine,
  embedder: Embedder,
  db: Db,
  byId: ReadonlyMap<number, ChunkWithDate>,
  limit: number,
): Promise<ChunkWithDate[]> {
  const kana = convertRomaji(query, { flush: true }).converted;
  const text = (await engine.convert(kana)).match(
    (candidates) => candidates[0] ?? kana,
    () => kana,
  );
  const [queryVector] = await embedder.embed([text]).catch(() => []);
  if (queryVector === undefined) {
    return [];
  }
  return loadVectors(db).match(
    (vectors) =>
      nearestChunks(vectors, queryVector, limit).flatMap((n) => {
        const chunk = byId.get(n.chunkId);
        return chunk === undefined ? [] : [chunk];
      }),
    (): ChunkWithDate[] => [],
  );
}
