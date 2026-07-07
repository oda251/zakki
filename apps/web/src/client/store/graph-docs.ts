/**
 * RxDB doc → グラフノードの純導出（issue #44）。
 *
 * サーバ getGraph（`@zakki/data/graph/queries.ts`）が SQL（再帰 CTE）で行っていた
 * 投影のクライアント版: root date 継承・childCount / descendantCount の再導出。
 * 派生値の定義は graph-core の recomputeCounts と共有する。
 *
 * 自動タグ（chunk_tags）・意味リンク（links）はサーバ解析の産物で replication
 * 対象外のため、tags は空・エッジはここでは導出しない（クライアント解析は #28/#26）。
 */
import type { ChunkDoc, ChunkUserTagDoc } from "@zakki/web/client/db/database.ts";
import { numId } from "@zakki/web/client/db/ids.ts";
import { recomputeCounts } from "@zakki/web/client/store/graph-core.ts";
import type { GraphNode } from "@zakki/web/shared/api-types.ts";

/** 祖先（自身を含む）の日付チャンクの date。辿れない（同期途中の孤児等）は "" */
function rootDate(byId: Map<string, ChunkDoc>, doc: ChunkDoc): string {
  let cursor: ChunkDoc | undefined = doc;
  while (cursor !== undefined) {
    if (cursor.date !== null) return cursor.date;
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return "";
}

/** RxDB の chunk / userTag docs から GraphNode 列（id 昇順）を導出する */
export function nodesFromDocs(
  chunks: readonly ChunkDoc[],
  userTags: readonly ChunkUserTagDoc[],
): GraphNode[] {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const tagsByChunk = new Map<string, string[]>();
  for (const t of userTags) {
    const list = tagsByChunk.get(t.chunkId) ?? [];
    list.push(t.name);
    tagsByChunk.set(t.chunkId, list);
  }

  const nodes = chunks.map(
    (c): GraphNode => ({
      id: numId(c.id),
      parentId: c.parentId === null ? null : numId(c.parentId),
      position: c.position,
      content: c.content,
      date: rootDate(byId, c),
      polarity: c.polarity,
      tags: [],
      userTags: (tagsByChunk.get(c.id) ?? []).toSorted(),
      childCount: 0,
      descendantCount: 0,
    }),
  );
  return recomputeCounts(nodes.toSorted((a, b) => a.id - b.id));
}
