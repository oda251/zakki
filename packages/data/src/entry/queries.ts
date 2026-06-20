import { asc, eq, sql } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import { NEUTRAL_BAND } from "@zakki/core/analysis/sentiment.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, chunkTags, entries, links, tags } from "@zakki/data/db/schema.ts";

/** 検索・エクスポート・関連表示で共有する「日付付きチャンク」ビュー */
export interface ChunkWithDate {
  id: number;
  entryId: number;
  position: number;
  content: string;
  date: string;
  /** 永続化済みネガポジ極性 [-1,+1]。未解析は null */
  polarity: number | null;
}

export function listChunksWithDate(db: Db): ResultAsync<ChunkWithDate[], DbError> {
  return tryDbAsync(() =>
    db
      .select({
        id: chunks.id,
        entryId: chunks.entryId,
        position: chunks.position,
        content: chunks.content,
        date: entries.date,
        polarity: chunks.polarity,
      })
      .from(chunks)
      .innerJoin(entries, eq(chunks.entryId, entries.id))
      .orderBy(asc(entries.date), asc(chunks.position)),
  );
}

/**
 * 指定チャンクとその前後（position 順の隣接 ±radius）を返す（関連の詳細展開用）。
 * 全チャンクをメモリに保持せず、必要時に切り出す。
 */
export function getChunkContext(
  db: Db,
  chunkId: number,
  radius: number,
): ResultAsync<ChunkWithDate[], DbError> {
  return listChunksWithDate(db).map((all) => {
    const i = all.findIndex((c) => c.id === chunkId);
    return i === -1 ? [] : all.slice(Math.max(0, i - radius), i + radius + 1);
  });
}

/**
 * chunk id → タグ名 の対応から、タグ出現数を数える。
 * chunkIds 指定時はその部分集合のみ（例: 特定期間）。digest / normalize-tags が共有。
 */
export function countTags(
  tagsByChunk: ReadonlyMap<number, string[]>,
  chunkIds?: Iterable<number>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of chunkIds ?? tagsByChunk.keys()) {
    for (const name of tagsByChunk.get(id) ?? []) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/** chunk id → タグ名（スコア降順） */
export function listTagsByChunk(db: Db): ResultAsync<Map<number, string[]>, DbError> {
  return tryDbAsync(async () => {
    const rows = await db
      .select({
        chunkId: chunkTags.chunkId,
        name: tags.name,
        score: chunkTags.score,
      })
      .from(chunkTags)
      .innerJoin(tags, eq(chunkTags.tagId, tags.id));
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
export function dailySentiment(db: Db): ResultAsync<DailySentiment[], DbError> {
  return tryDbAsync(() =>
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
      .orderBy(asc(entries.date)),
  );
}

/** chunk id → 関連 chunk id（スコア降順、双方向） */
export function listLinksByChunk(db: Db): ResultAsync<Map<number, number[]>, DbError> {
  return tryDbAsync(async () => {
    const rows = await db.select().from(links);
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
