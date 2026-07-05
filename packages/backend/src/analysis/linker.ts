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

/** ペアの Jaccard 類似度。閾値未満（共有 2 語未満または score < 0.2）は null */
function scorePair(a: ReadonlySet<string>, b: ReadonlySet<string>): number | null {
  let shared = 0;
  for (const noun of a) {
    if (b.has(noun)) shared += 1;
  }
  if (shared < MIN_SHARED_NOUNS) return null;
  const union = a.size + b.size - shared;
  const score = shared / union;
  return score >= MIN_SCORE ? score : null;
}

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
      if (a === undefined || b === undefined) continue;
      const score = scorePair(a.set, b.set);
      if (score !== null) {
        result.push({ fromChunkId: a.id, toChunkId: b.id, score });
      }
    }
  }
  return result;
}

/**
 * `targetIds` のチャンクが関与するリンク候補だけを再計算する（増分解析用）。
 *
 * リンクのスコアは両端の名詞集合のみで決まるため、両端とも target 外のペアは
 * 変化しない。target と名詞を 1 つ以上共有するチャンクだけを照合対象にする
 * ことで、全ペア O(N^2) を避けて O(影響範囲) にする。閾値・スコアは
 * {@link computeLinks} と同一（差し替え結果は全量再計算と一致する）。
 */
export function computeLinksFor(
  nounsByChunk: ReadonlyMap<number, readonly string[]>,
  targetIds: ReadonlySet<number>,
): LinkCandidate[] {
  const targetSets = new Map<number, Set<string>>();
  const targetNouns = new Set<string>();
  for (const id of targetIds) {
    const set = new Set(nounsByChunk.get(id) ?? []);
    if (set.size === 0) continue;
    targetSets.set(id, set);
    for (const noun of set) targetNouns.add(noun);
  }

  const result: LinkCandidate[] = [];
  // target × 非 target（名詞を共有するチャンクだけ照合する）
  for (const [id, nouns] of nounsByChunk) {
    if (targetIds.has(id)) continue;
    if (!nouns.some((noun) => targetNouns.has(noun))) continue;
    const set = new Set(nouns);
    for (const [targetId, targetSet] of targetSets) {
      const score = scorePair(targetSet, set);
      if (score !== null) {
        const [fromChunkId, toChunkId] = targetId < id ? [targetId, id] : [id, targetId];
        result.push({ fromChunkId, toChunkId, score });
      }
    }
  }
  // target × target
  const ids = [...targetSets.keys()].toSorted((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (a === undefined || b === undefined) continue;
      const setA = targetSets.get(a);
      const setB = targetSets.get(b);
      if (setA === undefined || setB === undefined) continue;
      const score = scorePair(setA, setB);
      if (score !== null) {
        result.push({ fromChunkId: a, toChunkId: b, score });
      }
    }
  }
  return result;
}
