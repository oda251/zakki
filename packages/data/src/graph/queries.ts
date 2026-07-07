import { sql } from "drizzle-orm";
import { ResultAsync } from "neverthrow";
import { AAD } from "@zakki/core/crypto/aad.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { rowsAs } from "@zakki/data/db/rows.ts";
import type { Chunk, Link } from "@zakki/data/db/schema.ts";
import { listTagsByChunk } from "@zakki/data/chunk/queries.ts";
import { ROOT_DATE_CTE } from "@zakki/data/chunk/sql.ts";
import { listUserTagsByChunk } from "@zakki/data/chunk/user-tags.ts";

/**
 * グラフビューのノード = chunk ツリーの全ノード（日付チャンク・コンテナ・本文）。
 * childCount / descendantCount は列に持たない派生値で、ここで再帰 CTE により付与する
 * （docs/CHUNKS.md §導出値と描画）。web クライアントはこれを全量受けてドリル表示する。
 *
 * 列はモデル（schema.ts の {@link Chunk}）から派生させる。schema の列変更は
 * ここで型エラーとして検出される（#50）。parentId が null = 日付チャンク（トップレベル）。
 */
export interface GraphNode extends Pick<
  Chunk,
  "id" | "parentId" | "position" | "content" | "polarity"
> {
  /** 祖先（自身を含む）の日付チャンクの date */
  date: NonNullable<Chunk["date"]>;
  /** 自動タグ（chunk_tags 由来、スコア降順） */
  tags: string[];
  /** ユーザ明示タグ（chunk_user_tags 由来） */
  userTags: string[];
  /** 直接の子数。0 なら葉（〇）、>0 ならコンテナ（◆） */
  childCount: number;
  /** 総子孫数。ノード半径のスケールに使う */
  descendantCount: number;
}

/**
 * グラフビューのエッジ。links（from < to 正規化済み）+ 導出の時系列リンク（chrono）。
 * 列は {@link Link} から派生（"chrono" のみ保存しない導出 origin）。
 */
export interface GraphEdge {
  from: Link["fromChunkId"];
  to: Link["toChunkId"];
  score: Link["score"];
  origin: Link["origin"] | "chrono";
}

export interface GraphData {
  /** 差分取得（?since=）の基準。chunks.updatedAt の最大値（空 DB は空文字 = 全量に一致） */
  version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 差分応答での生存ノード（削除検出 + 派生値の更新。id 昇順） */
export interface AliveNode extends Pick<Chunk, "id"> {
  childCount: number;
  descendantCount: number;
}

/**
 * 差分取得の応答（GET /api/graph?since=）。ノード本文（チャンク）だけが重いので
 * 変更分に絞り、残りは全量で返す:
 * - edges: links に updatedAt が無く増分検出できないが、1 本 4 スカラと軽量なので全量
 * - aliveNodes: id と派生値（childCount / descendantCount）のみの一覧。クライアントは
 *   これに無いノードを削除とみなし、あるノードの派生値を更新する
 *   （子の追加は親自身の updatedAt を動かさないため、派生値は全量で送る）
 */
export interface GraphDelta {
  version: string;
  /** updatedAt >= since のチャンク（ノード形） */
  nodes: GraphNode[];
  aliveNodes: AliveNode[];
  edges: GraphEdge[];
}

/** 差分取得の基準時刻 = chunks.updatedAt の最大値（ISO 文字列は辞書順比較可能） */
function maxChunkUpdatedAt(db: Db): ResultAsync<string, DbError> {
  return tryDbAsync(async () => {
    const res = await db.run(sql`SELECT max(updated_at) AS max FROM chunks`);
    const rows = rowsAs<{ max: Chunk["updatedAt"] | null }>(res);
    return rows[0]?.max ?? "";
  });
}

/**
 * listNodeRows の SELECT 別名列に 1:1 対応する生 Row（content は暗号文のままでありうる。
 * 復号は toNodes）。列は {@link Chunk} から派生（chunk/sql.ts の ROOT_DATE_CTE も参照）。
 */
interface RawNodeRow extends Pick<Chunk, "id" | "parentId" | "position" | "content" | "polarity"> {
  /** 祖先（自身を含む）の日付チャンクの date（ROOT_DATE_CTE の root_date） */
  date: NonNullable<Chunk["date"]>;
  /** 自身の date 列（日付チャンク判定 = 復号スキップ判定） */
  ownDate: Chunk["date"];
}

/** 全ノード（since 指定時は updatedAt >= since のみ）を root date 付きで読む */
function listNodeRows(db: Db, since?: string): ResultAsync<RawNodeRow[], DbError> {
  return tryDbAsync(async () => {
    const filter = since === undefined ? sql`` : sql`WHERE c.updated_at >= ${since}`;
    const res = await db.run(sql`
      ${ROOT_DATE_CTE}
      SELECT c.id AS id, c.parent_id AS parentId, c.position AS position,
             c.content AS content, r.root_date AS date, c.date AS ownDate, c.polarity AS polarity
      FROM chunks c JOIN roots r ON c.id = r.id
      ${filter}
      ORDER BY c.id ASC
    `);
    return rowsAs<RawNodeRow>(res);
  });
}

/** id → 派生値（childCount / descendantCount）。全チャンク分（= aliveNodes の素） */
function listCounts(db: Db): ResultAsync<AliveNode[], DbError> {
  return tryDbAsync(async () => {
    const res = await db.run(sql`
      WITH RECURSIVE sub(root, id) AS (
        SELECT id, id FROM chunks
        UNION ALL
        SELECT s.root, c.id FROM chunks c JOIN sub s ON c.parent_id = s.id
      )
      SELECT root AS id,
             count(*) - 1 AS descendantCount,
             (SELECT count(*) FROM chunks ch WHERE ch.parent_id = root) AS childCount
      FROM sub GROUP BY root ORDER BY root ASC
    `);
    return rowsAs<AliveNode>(res);
  });
}

function toNodes(
  db: Db,
  rows: RawNodeRow[],
  counts: ReadonlyMap<number, AliveNode>,
  tagsByChunk: ReadonlyMap<number, string[]>,
  userTagsByChunk: ReadonlyMap<number, string[]>,
): GraphNode[] {
  const crypto = getCrypto(db);
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parentId,
    position: r.position,
    // 日付チャンク（ownDate 非 NULL）の content は平文（date と同値）
    content:
      crypto === undefined || r.ownDate !== null
        ? r.content
        : crypto.decString(r.content, AAD.chunkContent),
    date: r.date,
    polarity: r.polarity,
    tags: tagsByChunk.get(r.id) ?? [],
    userTags: userTagsByChunk.get(r.id) ?? [],
    childCount: counts.get(r.id)?.childCount ?? 0,
    descendantCount: counts.get(r.id)?.descendantCount ?? 0,
  }));
}

function listStoredEdges(db: Db): ResultAsync<GraphEdge[], DbError> {
  return tryDbAsync(async () => {
    const res = await db.run(
      sql`SELECT from_chunk_id AS "from", to_chunk_id AS "to", score, origin FROM links`,
    );
    return rowsAs<GraphEdge>(res);
  });
}

/**
 * 日付チャンク間の時系列リンクを導出する（docs/CHUNKS.md §日付チャンク）。
 * date 昇順で隣接する日付チャンク同士を結ぶ（保存しない: 過去日の後挿入でも
 * 常に正しく、links の再張替えが不要）。from < to へ正規化する。
 */
function chronoEdges(db: Db): ResultAsync<GraphEdge[], DbError> {
  return tryDbAsync(async () => {
    const res = await db.run(
      sql`SELECT id, date FROM chunks WHERE date IS NOT NULL ORDER BY date ASC`,
    );
    const rows = rowsAs<Pick<Chunk, "id"> & { date: NonNullable<Chunk["date"]> }>(res);
    const edges: GraphEdge[] = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a === undefined || b === undefined) continue;
      const [from, to] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      edges.push({ from, to, score: 1, origin: "chrono" });
    }
    return edges;
  });
}

/**
 * グラフビュー用の全量取得。ノード = chunk ツリー全体、エッジ = links + 時系列導出。
 * 数千ノード規模を想定し、絞り込み（ドリル表示）はクライアント側で行う。
 *
 * version は取得中の書き込みと厳密には直列化しないが、差分側の >= 比較と
 * aliveNodes 全量により、ずれは「次回の過剰送信」にしかならない。
 */
export function getGraph(db: Db): ResultAsync<GraphData, DbError> {
  return ResultAsync.combine([
    listNodeRows(db),
    listCounts(db),
    listStoredEdges(db),
    chronoEdges(db),
    listTagsByChunk(db),
    listUserTagsByChunk(db),
    maxChunkUpdatedAt(db),
  ]).map(([rows, counts, stored, chrono, tagsByChunk, userTagsByChunk, version]) => {
    const countsById = new Map(counts.map((c) => [c.id, c]));
    return {
      version,
      nodes: toNodes(db, rows, countsById, tagsByChunk, userTagsByChunk),
      edges: [...stored, ...chrono],
    };
  });
}

/**
 * 差分取得（GET /api/graph?since=）。since 以降（境界含む）に更新された
 * チャンクだけをノード形で返し、転送量を「変化した分」に比例させる。
 * 解析（タグ・極性）の変化は analyzeAll / analyzeChanged が chunks.updatedAt を
 * 進めることで拾う（実際に値が変わったチャンクだけ bump し、冪等再実行では動かさない）。
 */
export function getGraphDelta(db: Db, since: string): ResultAsync<GraphDelta, DbError> {
  return ResultAsync.combine([
    listNodeRows(db, since),
    listCounts(db),
    listStoredEdges(db),
    chronoEdges(db),
    listTagsByChunk(db),
    listUserTagsByChunk(db),
    maxChunkUpdatedAt(db),
  ]).map(([rows, counts, stored, chrono, tagsByChunk, userTagsByChunk, version]) => {
    const countsById = new Map(counts.map((c) => [c.id, c]));
    return {
      version,
      nodes: toNodes(db, rows, countsById, tagsByChunk, userTagsByChunk),
      aliveNodes: counts,
      edges: [...stored, ...chrono],
    };
  });
}
