import { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { links } from "@zakki/data/db/schema.ts";
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
  nodes: GraphNode[];
  edges: GraphEdge[];
  sessions: SessionWithTags[];
}

/**
 * グラフビュー用の全量取得。ノード=チャンク、エッジ=links、色分け・フィルタ用に
 * セッション一覧を添える。数千ノード規模を想定し、絞り込みはクライアント側で行う。
 */
export function getGraph(db: Db): ResultAsync<GraphData, DbError> {
  return ResultAsync.combine([
    listChunksWithDate(db),
    tryDbAsync(() => db.select().from(links)),
    listTagsByChunk(db),
    listSessions(db),
  ]).map(([chunkList, edgeRows, tagsByChunk, sessionList]) => {
    const nameBySession = new Map(sessionList.map((s) => [s.id, s.name]));
    return {
      nodes: chunkList.map((c) => ({
        id: c.id,
        content: c.content,
        date: c.date,
        sessionId: c.sessionId,
        sessionName: nameBySession.get(c.sessionId) ?? null,
        polarity: c.polarity,
        tags: tagsByChunk.get(c.id) ?? [],
      })),
      edges: edgeRows.map((e) => ({
        from: e.fromChunkId,
        to: e.toChunkId,
        score: e.score,
        origin: e.origin,
      })),
      sessions: sessionList,
    };
  });
}
