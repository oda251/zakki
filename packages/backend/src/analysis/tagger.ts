/**
 * TF-IDF によるキーワードタグ付け（docs/CONCEPT.md §3、docs/FEATURES.md Phase 3）。
 * 入力は「チャンク id → 名詞列（重複あり）」。コーパスは全チャンク。
 */

import type { TagScore } from "@zakki/data/analysis/apply.ts";

// タグ 1 件のスコア付き表現。永続化契約（chunk_tags 行の平文表現）として data 層が定義する
export type { TagScore } from "@zakki/data/analysis/apply.ts";

const MAX_TAGS_PER_CHUNK = 3;

export function computeTags(
  nounsByChunk: ReadonlyMap<number, readonly string[]>,
): Map<number, TagScore[]> {
  const documentCount = nounsByChunk.size;
  // DF: 名詞 → 出現チャンク数
  const df = new Map<string, number>();
  for (const nouns of nounsByChunk.values()) {
    for (const noun of new Set(nouns)) {
      df.set(noun, (df.get(noun) ?? 0) + 1);
    }
  }

  const result = new Map<number, TagScore[]>();
  for (const [chunkId, nouns] of nounsByChunk) {
    if (nouns.length === 0) {
      result.set(chunkId, []);
      continue;
    }
    const tf = new Map<string, number>();
    for (const noun of nouns) {
      tf.set(noun, (tf.get(noun) ?? 0) + 1);
    }
    const scores: TagScore[] = [...tf.entries()].map(([name, count]) => ({
      name,
      score: (count / nouns.length) * Math.log(1 + documentCount / (df.get(name) ?? 1)),
    }));
    scores.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    result.set(chunkId, scores.slice(0, MAX_TAGS_PER_CHUNK));
  }
  return result;
}
