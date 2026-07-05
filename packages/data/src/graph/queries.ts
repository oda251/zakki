import { asc, sql } from "drizzle-orm";
import { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, links } from "@zakki/data/db/schema.ts";
import type { ChunkWithDate } from "@zakki/data/entry/queries.ts";
import { listChunksWithDate, listTagsByChunk } from "@zakki/data/entry/queries.ts";
import type { SessionWithTags } from "@zakki/data/session/repository.ts";
import { listSessions } from "@zakki/data/session/repository.ts";

/** グラフビューのノード = チャンク（web クライアントはこれを全量受けてフィルタする） */
export interface GraphNode {
  id: number;
  content: string;
  date: string;
  sessionId: number;
  sessionName: string | null;
  polarity: number | null;
  /** 自動タグ（chunk_tags 由来、スコア降順） */
  tags: string[];
}

/** グラフビューのエッジ = links（from < to で正規化済み） */
export interface GraphEdge {
  from: number;
  to: number;
  score: number;
  origin: "auto" | "manual";
}

export interface GraphData {
  /** 差分取得（?since=）の基準。chunks.updatedAt の最大値（空 DB は空文字 = 全量に一致） */
  version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sessions: SessionWithTags[];
}

/**
 * 差分取得の応答（GET /api/graph?since=）。ノード本文（チャンク）だけが重いので
 * 変更分に絞り、残りは全量で返す:
 * - edges: links に updatedAt が無く増分検出できないが、1 本 4 スカラと軽量なので全量
 * - sessions: 件数が少なく、改名・タグ変更の検出列も転送削減の旨味も無いので全量
 * - aliveNodeIds: id のみの一覧。クライアントはこれに無いノードを削除とみなす
 */
export interface GraphDelta {
  version: string;
  /** updatedAt >= since のチャンク（ノード形） */
  nodes: GraphNode[];
  /** 現存する全チャンク id（削除検出用、昇順） */
  aliveNodeIds: number[];
  edges: GraphEdge[];
  sessions: SessionWithTags[];
}

/** 差分取得の基準時刻 = chunks.updatedAt の最大値（ISO 文字列は辞書順比較可能） */
function maxChunkUpdatedAt(db: Db): ResultAsync<string, DbError> {
  return tryDbAsync(async () => {
    const rows = await db
      .select({ max: sql<string | null>`max(${chunks.updatedAt})` })
      .from(chunks);
    return rows[0]?.max ?? "";
  });
}

function toNodes(
  chunkList: ChunkWithDate[],
  tagsByChunk: ReadonlyMap<number, string[]>,
  sessionList: SessionWithTags[],
): GraphNode[] {
  const nameBySession = new Map(sessionList.map((s) => [s.id, s.name]));
  return chunkList.map((c) => ({
    id: c.id,
    content: c.content,
    date: c.date,
    sessionId: c.sessionId,
    sessionName: nameBySession.get(c.sessionId) ?? null,
    polarity: c.polarity,
    tags: tagsByChunk.get(c.id) ?? [],
  }));
}

function listEdges(db: Db): ResultAsync<GraphEdge[], DbError> {
  return tryDbAsync(() => db.select().from(links)).map((rows) =>
    rows.map((e) => ({ from: e.fromChunkId, to: e.toChunkId, score: e.score, origin: e.origin })),
  );
}

/**
 * グラフビュー用の全量取得。ノード=チャンク、エッジ=links、色分け・フィルタ用に
 * セッション一覧を添える。数千ノード規模を想定し、絞り込みはクライアント側で行う。
 *
 * version は取得中の書き込みと厳密には直列化しないが、差分側の >= 比較と
 * aliveNodeIds 全量により、ずれは「次回の過剰送信」にしかならない。
 */
export function getGraph(db: Db): ResultAsync<GraphData, DbError> {
  return ResultAsync.combine([
    listChunksWithDate(db),
    listEdges(db),
    listTagsByChunk(db),
    listSessions(db),
    maxChunkUpdatedAt(db),
  ]).map(([chunkList, edges, tagsByChunk, sessionList, version]) => ({
    version,
    nodes: toNodes(chunkList, tagsByChunk, sessionList),
    edges,
    sessions: sessionList,
  }));
}

/**
 * 差分取得（GET /api/graph?since=）。since 以降（境界含む）に更新された
 * チャンクだけをノード形で返し、転送量を「変化した分」に比例させる。
 * 解析（タグ・極性）の変化は analyzeAll / analyzeChanged が chunks.updatedAt を
 * 進めることで拾う（実際に値が変わったチャンクだけ bump し、冪等再実行では動かさない）。
 */
export function getGraphDelta(db: Db, since: string): ResultAsync<GraphDelta, DbError> {
  return ResultAsync.combine([
    listChunksWithDate(db, since),
    tryDbAsync(() => db.select({ id: chunks.id }).from(chunks).orderBy(asc(chunks.id))),
    listEdges(db),
    listTagsByChunk(db),
    listSessions(db),
    maxChunkUpdatedAt(db),
  ]).map(([chunkList, aliveRows, edges, tagsByChunk, sessionList, version]) => ({
    version,
    nodes: toNodes(chunkList, tagsByChunk, sessionList),
    aliveNodeIds: aliveRows.map((r) => r.id),
    edges,
    sessions: sessionList,
  }));
}
