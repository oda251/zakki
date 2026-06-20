import type { Result } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDb } from "@zakki/data/db/error.ts";
import { links } from "@zakki/data/db/schema.ts";
import { cosine } from "./vector.ts";

/**
 * セマンティック関連付け（docs/FEATURES.md Phase 4）。
 * ruri-v3 は無関係文でも類似度 0.75 前後と高めに出るため（2026-06-13 実測）、
 * 閾値はキーワード関連付けより高い 0.88 とする。
 */
export const SEMANTIC_LINK_MIN_SCORE = 0.88;

/**
 * 埋め込み近傍のチャンク対を links に追加する。
 * analyzeAll（キーワード関連付け）が auto リンクを再生成した後に呼び、
 * 既存ペアは onConflictDoNothing で残す。
 */
export function addSemanticLinks(
  db: Db,
  vectors: ReadonlyMap<number, Float32Array>,
): Result<{ added: number }, DbError> {
  const ids = [...vectors.keys()].toSorted((a, b) => a - b);
  return tryDb(() => {
    let added = 0;
    db.transaction((tx) => {
      const existing = new Set(
        tx
          .select()
          .from(links)
          .all()
          .map((r) => `${r.fromChunkId}:${r.toChunkId}`),
      );
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i];
          const b = ids[j];
          if (a === undefined || b === undefined) continue;
          if (existing.has(`${a}:${b}`)) continue;
          const va = vectors.get(a);
          const vb = vectors.get(b);
          if (va === undefined || vb === undefined) continue;
          const score = cosine(va, vb);
          if (score < SEMANTIC_LINK_MIN_SCORE) continue;
          tx.insert(links).values({ fromChunkId: a, toChunkId: b, score, origin: "auto" }).run();
          added += 1;
        }
      }
    });
    return { added };
  });
}

/** クエリベクトルの近傍チャンク id（スコア降順、上位 topK） */
export function nearestChunks(
  vectors: ReadonlyMap<number, Float32Array>,
  query: Float32Array,
  topK: number,
  minScore: number = 0.8,
): { chunkId: number; score: number }[] {
  const scored: { chunkId: number; score: number }[] = [];
  for (const [chunkId, vector] of vectors) {
    const score = cosine(query, vector);
    if (score >= minScore) {
      scored.push({ chunkId, score });
    }
  }
  return scored.toSorted((a, b) => b.score - a.score).slice(0, topK);
}
