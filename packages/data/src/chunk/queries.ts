import { sql } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import { AAD } from "@zakki/core/crypto/aad.ts";
import { NEUTRAL_BAND } from "@zakki/core/analysis/sentiment.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { rowsAs } from "@zakki/data/db/rows.ts";
import type { Chunk, ChunkTag, Link, Tag } from "@zakki/data/db/schema.ts";
import { ROOT_DATE_CTE } from "@zakki/data/chunk/sql.ts";

/**
 * 検索・エクスポート・関連表示で共有する「日付付き本文チャンク」ビュー。
 * date はツリーを遡った祖先の日付チャンクの date（本文チャンク自身は date を
 * 持たない）。日付チャンク（構造ノード）はここには現れない。
 *
 * 列はモデル（schema.ts の {@link Chunk}）から派生させる。schema の列変更は
 * ここで型エラーとして検出される（#50。SQL 別名との対応は chunk/sql.ts を参照）。
 */
export interface ChunkWithDate extends Pick<Chunk, "id" | "position" | "content" | "polarity"> {
  /** 本文チャンクは必ず親（日付チャンクまたはコンテナ）を持つ */
  parentId: NonNullable<Chunk["parentId"]>;
  /** 祖先の日付チャンクの date（ROOT_DATE_CTE の root_date） */
  date: NonNullable<Chunk["date"]>;
}

/**
 * listChunksWithDate / listChunksByIds の SELECT 別名列に 1:1 対応する生 Row
 * （chunk/sql.ts の ROOT_DATE_CTE 参照）。形は ChunkWithDate と同一で、
 * content が暗号文のままでありうる点だけが異なる（復号は toChunkWithDate）。
 */
type RawChunkRow = ChunkWithDate;

function toChunkWithDate(db: Db, rows: RawChunkRow[]): ChunkWithDate[] {
  const crypto = getCrypto(db);
  if (crypto === undefined) return rows;
  return rows.map((r) => ({ ...r, content: crypto.decString(r.content, AAD.chunkContent) }));
}

/**
 * @param since 指定時は `chunks.updatedAt >= since` のみ返す（グラフ差分取得用）。
 *   同一ミリ秒の書き込みを取りこぼさないよう境界は含める（過剰送信側に倒す）。
 */
export function listChunksWithDate(db: Db, since?: string): ResultAsync<ChunkWithDate[], DbError> {
  return tryDbAsync(async () => {
    const filter = since === undefined ? sql`` : sql`AND c.updated_at >= ${since}`;
    const res = await db.run(sql`
      ${ROOT_DATE_CTE}
      SELECT c.id AS id, c.parent_id AS parentId, c.position AS position,
             c.content AS content, r.root_date AS date, c.polarity AS polarity
      FROM chunks c JOIN roots r ON c.id = r.id
      WHERE c.parent_id IS NOT NULL ${filter}
      ORDER BY r.root_date ASC, c.parent_id ASC, c.position ASC
    `);
    return toChunkWithDate(db, rowsAs<RawChunkRow>(res));
  });
}

/**
 * id 指定でチャンクを読む（日付付き・復号済み）。近傍ハイドレート等、
 * 少数の対象だけ復号したいときに listChunksWithDate の全量復号を避ける。
 */
export function listChunksByIds(db: Db, ids: number[]): ResultAsync<ChunkWithDate[], DbError> {
  return tryDbAsync(async () => {
    if (ids.length === 0) return [];
    const idList = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    const res = await db.run(sql`
      ${ROOT_DATE_CTE}
      SELECT c.id AS id, c.parent_id AS parentId, c.position AS position,
             c.content AS content, r.root_date AS date, c.polarity AS polarity
      FROM chunks c JOIN roots r ON c.id = r.id
      WHERE c.parent_id IS NOT NULL AND c.id IN (${idList})
    `);
    return toChunkWithDate(db, rowsAs<RawChunkRow>(res));
  });
}

/**
 * 指定チャンクとその前後（一覧順の隣接 ±radius）を返す（関連の詳細展開用）。
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

/** listTagsByChunk の SELECT 別名列（chunk_tags ⋈ tags）に対応する Row */
type ChunkTagNameRow = Pick<ChunkTag, "chunkId" | "score"> & Pick<Tag, "name">;

/** chunk id → タグ名（スコア降順） */
export function listTagsByChunk(db: Db): ResultAsync<Map<number, string[]>, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const res = await db.run(sql`
      SELECT ct.chunk_id AS chunkId, t.name AS name, ct.score AS score
      FROM chunk_tags ct JOIN tags t ON ct.tag_id = t.id
    `);
    const rows = rowsAs<ChunkTagNameRow>(res);
    const sorted = rows.toSorted((a, b) => b.score - a.score);
    const result = new Map<number, string[]>();
    for (const row of sorted) {
      const name = crypto === undefined ? row.name : crypto.decString(row.name, AAD.tagName);
      const list = result.get(row.chunkId) ?? [];
      list.push(name);
      result.set(row.chunkId, list);
    }
    return result;
  });
}

/** 日ごとのネガポジ極性の集計（docs/FEATURES.md §整理・想起系 7）。date 以外は SQL 集計の派生値 */
export interface DailySentiment {
  date: NonNullable<Chunk["date"]>;
  /** その日の本文チャンク総数 */
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
 * 日付（祖先の日付チャンク）ごとに極性を SQL 集計する（永続化された chunks.polarity を読む）。
 * 分類閾値は scoreSentiment と共有（NEUTRAL_BAND）。未算出（null）は average から除外し、
 * positive/negative/neutral にも数えない（scored が分母）。
 */
export function dailySentiment(db: Db): ResultAsync<DailySentiment[], DbError> {
  return tryDbAsync(async () => {
    const res = await db.run(sql`
      ${ROOT_DATE_CTE}
      SELECT r.root_date AS date,
             count(*) AS chunks,
             count(c.polarity) AS scored,
             avg(c.polarity) AS average,
             sum(CASE WHEN c.polarity > ${NEUTRAL_BAND} THEN 1 ELSE 0 END) AS positive,
             sum(CASE WHEN c.polarity < ${-NEUTRAL_BAND} THEN 1 ELSE 0 END) AS negative,
             sum(CASE WHEN c.polarity BETWEEN ${-NEUTRAL_BAND} AND ${NEUTRAL_BAND} THEN 1 ELSE 0 END) AS neutral
      FROM chunks c JOIN roots r ON c.id = r.id
      WHERE c.parent_id IS NOT NULL
      GROUP BY r.root_date ORDER BY r.root_date ASC
    `);
    return rowsAs<DailySentiment>(res);
  });
}

/** chunk id → 関連 chunk id（スコア降順、双方向） */
export function listLinksByChunk(db: Db): ResultAsync<Map<number, number[]>, DbError> {
  return tryDbAsync(async () => {
    const res = await db.run(
      sql`SELECT from_chunk_id AS fromChunkId, to_chunk_id AS toChunkId, score FROM links`,
    );
    const rows = rowsAs<Pick<Link, "fromChunkId" | "toChunkId" | "score">>(res);
    const sorted = rows.toSorted((a, b) => b.score - a.score);
    const result = new Map<number, number[]>();
    const push = (from: number, to: number) => {
      const list = result.get(from) ?? [];
      list.push(to);
      result.set(from, list);
    };
    for (const row of sorted) {
      push(row.fromChunkId, row.toChunkId);
      push(row.toChunkId, row.fromChunkId);
    }
    return result;
  });
}
