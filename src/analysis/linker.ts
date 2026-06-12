/**
 * キーワード（名詞）集合の類似度によるチャンク関連付け
 * （docs/CONCEPT.md §3。embedding 導入前の Phase 3 実装）。
 * 双方向リンクとして扱うため (from < to) に正規化したペアを返す。
 */

export interface LinkCandidate {
  fromChunkId: number;
  toChunkId: number;
  /** Jaccard 類似度 */
  score: number;
}

const MIN_SHARED_NOUNS = 2;
const MIN_SCORE = 0.2;

export function computeLinks(
  nounsByChunk: ReadonlyMap<number, readonly string[]>,
): LinkCandidate[] {
  const sets = [...nounsByChunk.entries()]
    .map(([id, nouns]) => ({ id, set: new Set(nouns) }))
    .filter((c) => c.set.size > 0)
    .toSorted((a, b) => a.id - b.id);

  const result: LinkCandidate[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i];
      const b = sets[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      let shared = 0;
      for (const noun of a.set) {
        if (b.set.has(noun)) {
          shared += 1;
        }
      }
      if (shared < MIN_SHARED_NOUNS) {
        continue;
      }
      const union = a.set.size + b.set.size - shared;
      const score = shared / union;
      if (score >= MIN_SCORE) {
        result.push({ fromChunkId: a.id, toChunkId: b.id, score });
      }
    }
  }
  return result;
}
