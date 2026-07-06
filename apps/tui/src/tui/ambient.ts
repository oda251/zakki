import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import { nearestChunks } from "@zakki/data/embedding/semantic.ts";

/** 関連（アンビエント）一覧の項目。タイトルは描画時に makeTitle で導出する（派生値は保持しない）。 */
export interface AmbientItem {
  chunkId: number;
  date: string;
  content: string;
}

/**
 * アンビエント表示の項目を導出する純粋関数（docs/FEATURES.md 候補1）。
 * 当日チャンクの最後の 1 件を基準に意味的近傍を取り、自己を除いて上位 limit 件を返す。
 * 基準チャンクが無い / そのベクトルが無い場合は空（呼び出し側は setAmbient に流す）。
 */
export function selectAmbient(
  all: ChunkWithDate[],
  vectors: ReadonlyMap<number, Float32Array>,
  date: string,
  limit: number,
): AmbientItem[] {
  const todays = all.filter((c) => c.date === date);
  const last = todays.at(-1);
  const lastVector = last === undefined ? undefined : vectors.get(last.id);
  if (last === undefined || lastVector === undefined) {
    return [];
  }
  const byId = new Map(all.map((c) => [c.id, c]));
  return nearestChunks(vectors, lastVector, limit + 1)
    .filter((n) => n.chunkId !== last.id)
    .slice(0, limit)
    .flatMap((n) => {
      const chunk = byId.get(n.chunkId);
      return chunk === undefined
        ? []
        : [{ chunkId: chunk.id, date: chunk.date, content: chunk.content }];
    });
}
