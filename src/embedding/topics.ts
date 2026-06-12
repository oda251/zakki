import { cosine } from "./embedder.ts";

/**
 * 話題転換検出（docs/CONCEPT.md §2 の二次区切り）。
 * 隣接セグメントの埋め込み類似度が閾値を下回る点を話題境界とみなす。
 * ruri-v3 のベースライン類似度が高い（無関係文で 0.75 前後）ため閾値は 0.85。
 */
export const TOPIC_BOUNDARY_THRESHOLD = 0.85;

/**
 * boundaries[i] = true なら「i 番目の直前」が話題境界（i は 1 以上）。
 * 戻り値の長さは vectors.length（先頭は常に false）。
 */
export function detectBoundaries(
  vectors: readonly Float32Array[],
  threshold: number = TOPIC_BOUNDARY_THRESHOLD,
): boolean[] {
  return vectors.map((vector, i) => {
    if (i === 0) {
      return false;
    }
    const prev = vectors[i - 1];
    return prev === undefined ? false : cosine(prev, vector) < threshold;
  });
}

/** 境界情報で隣接要素をグループ化する */
export function groupByBoundaries<T>(items: readonly T[], boundaries: readonly boolean[]): T[][] {
  const groups: T[][] = [];
  items.forEach((item, i) => {
    const last = groups[groups.length - 1];
    if (i === 0 || boundaries[i] === true || last === undefined) {
      groups.push([item]);
    } else {
      last.push(item);
    }
  });
  return groups;
}
