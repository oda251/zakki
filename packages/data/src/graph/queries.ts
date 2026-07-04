import { asc, eq } from "drizzle-orm";
import { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, entries, links, sessions } from "@zakki/data/db/schema.ts";
import { listTagsByChunk } from "@zakki/data/entry/queries.ts";
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
  nodes: GraphNode[];
  edges: GraphEdge[];
  sessions: SessionWithTags[];
}

/**
 * グラフビュー用の全量取得。ノード=チャンク、エッジ=links、色分け・フィルタ用に
 * セッション一覧を添える。数千ノード規模を想定し、絞り込みはクライアント側で行う。
 */
export function getGraph(db: Db): ResultAsync<GraphData, DbError> {
  const crypto = getCrypto(db);
  const nodesResult = tryDbAsync(async () => {
    const rows = await db
      .select({
        id: chunks.id,
        content: chunks.content,
        polarity: chunks.polarity,
        date: entries.date,
        sessionId: entries.sessionId,
        sessionName: sessions.name,
      })
      .from(chunks)
      .innerJoin(entries, eq(chunks.entryId, entries.id))
      .innerJoin(sessions, eq(entries.sessionId, sessions.id))
      .orderBy(asc(entries.date), asc(chunks.position));
    if (crypto === undefined) return rows;
    return rows.map((r) => ({
      ...r,
      content: crypto.decString(r.content, "chunk.content"),
      sessionName: r.sessionName === null ? null : crypto.decString(r.sessionName, "session.name"),
    }));
  });
  const edgesResult = tryDbAsync(() => db.select().from(links));
  return ResultAsync.combine([nodesResult, edgesResult, listTagsByChunk(db), listSessions(db)]).map(
    ([nodes, edgeRows, tagsByChunk, sessionList]) => ({
      nodes: nodes.map((n) => ({ ...n, tags: tagsByChunk.get(n.id) ?? [] })),
      edges: edgeRows.map((e) => ({
        from: e.fromChunkId,
        to: e.toChunkId,
        score: e.score,
        origin: e.origin,
      })),
      sessions: sessionList,
    }),
  );
}
