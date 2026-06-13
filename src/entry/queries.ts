import { asc, eq, sql } from "drizzle-orm";
import type { Result } from "neverthrow";
import { NEUTRAL_BAND } from "@/analysis/sentiment.ts";
import type { Db } from "@/db/client.ts";
import type { DbError } from "@/db/error.ts";
import { tryDb } from "@/db/error.ts";
import { chunks, chunkTags, entries, links, tags } from "@/db/schema.ts";

/** 検索・エクスポート・関連表示で共有する「日付付きチャンク」ビュー */
export interface ChunkWithDate {
  id: number;
  entryId: number;
  position: number;
  title: string;
  content: string;
  date: string;
}

export function listChunksWithDate(db: Db): Result<ChunkWithDate[], DbError> {
  return tryDb(() =>
    db
      .select({
        id: chunks.id,
        entryId: chunks.entryId,
        position: chunks.position,
        title: chunks.title,
        content: chunks.content,
        date: entries.date,
      })
      .from(chunks)
      .innerJoin(entries, eq(chunks.entryId, entries.id))
      .orderBy(asc(entries.date), asc(chunks.position))
      .all(),
  );
}

/** chunk id → タグ名（スコア降順） */
export function listTagsByChunk(db: Db): Result<Map<number, string[]>, DbError> {
  return tryDb(() => {
    const rows = db
      .select({
        chunkId: chunkTags.chunkId,
        name: tags.name,
        score: chunkTags.score,
      })
      .from(chunkTags)
      .innerJoin(tags, eq(chunkTags.tagId, tags.id))
      .all();
    rows.sort((a, b) => b.score - a.score);
    const result = new Map<number, string[]>();
    for (const row of rows) {
      const list = result.get(row.chunkId) ?? [];
      list.push(row.name);
      result.set(row.chunkId, list);
    }
    return result;
  });
}

/** 日ごとのネガポジ極性の集計（docs/FEATURES.md §整理・想起系 7） */
export interface DailySentiment {
  date: string;
  /** その日のチャンク総数 */
  chunks: number;
  /** 極性が算出済み（解析済み）のチャンク数 */
  scored: number;
  /** 算出済みチャンクの平均極性。未算出のみなら null */
  average: number | null;
  positive: number;
  negative: number;
  neutral: number;
}

/**
 * 日付ごとに極性を SQL 集計する（永続化された chunks.polarity を読む）。
 * 分類閾値は scoreSentiment と共有（NEUTRAL_BAND）。未算出（null）は average から除外し、
 * positive/negative/neutral にも数えない（scored が分母）。
 */
export function dailySentiment(db: Db): Result<DailySentiment[], DbError> {
  return tryDb(() =>
    db
      .select({
        date: entries.date,
        chunks: sql<number>`count(*)`,
        scored: sql<number>`count(${chunks.polarity})`,
        average: sql<number | null>`avg(${chunks.polarity})`,
        positive: sql<number>`sum(case when ${chunks.polarity} > ${NEUTRAL_BAND} then 1 else 0 end)`,
        negative: sql<number>`sum(case when ${chunks.polarity} < ${-NEUTRAL_BAND} then 1 else 0 end)`,
        neutral: sql<number>`sum(case when ${chunks.polarity} between ${-NEUTRAL_BAND} and ${NEUTRAL_BAND} then 1 else 0 end)`,
      })
      .from(chunks)
      .innerJoin(entries, eq(chunks.entryId, entries.id))
      .groupBy(entries.date)
      .orderBy(asc(entries.date))
      .all(),
  );
}

/** chunk id → 関連 chunk id（スコア降順、双方向） */
export function listLinksByChunk(db: Db): Result<Map<number, number[]>, DbError> {
  return tryDb(() => {
    const rows = db.select().from(links).all();
    rows.sort((a, b) => b.score - a.score);
    const result = new Map<number, number[]>();
    const push = (from: number, to: number) => {
      const list = result.get(from) ?? [];
      list.push(to);
      result.set(from, list);
    };
    for (const row of rows) {
      push(row.fromChunkId, row.toChunkId);
      push(row.toChunkId, row.fromChunkId);
    }
    return result;
  });
}
