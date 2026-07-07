/**
 * RxDB doc → グラフノードの純導出（issue #44）。
 *
 * サーバ getGraph（`@zakki/data/graph/queries.ts`）が SQL（再帰 CTE）で行っていた
 * 投影のクライアント版: root date 継承・childCount / descendantCount の再導出。
 * 派生値の定義は graph-core の recomputeCounts と共有する。
 *
 * エッジは links コレクション（#77 で永続化）から {@link edgesFromDocs} で導出する。
 * 自動タグ（chunk_tags）はサーバ解析の産物で replication 対象外のため tags は空
 * （クライアント解析は #28/#26、意味リンクの生成も同じく M6）。
 */
import type { ChunkDoc, ChunkUserTagDoc, LinkDoc } from "@zakki/web/client/db/database.ts";
import { numId } from "@zakki/web/client/db/ids.ts";
import { recomputeCounts } from "@zakki/web/client/store/graph-core.ts";
import type { GraphEdge, GraphNode } from "@zakki/web/shared/api-types.ts";

/**
 * 各チャンクの「祖先（自身を含む）の日付チャンクの date」。辿れない
 * （同期途中の孤児等）は ""。経路圧縮で全体 O(N)（liveQuery の emit ごとに
 * 走るため、深いツリーでの per-node 再走査を避ける）。
 */
function rootDates(chunks: readonly ChunkDoc[], byId: Map<string, ChunkDoc>): Map<string, string> {
  const dates = new Map<string, string>();
  for (const chunk of chunks) {
    const path: string[] = [];
    let date = "";
    let cursor: ChunkDoc | undefined = chunk;
    while (cursor !== undefined) {
      const hit = dates.get(cursor.id);
      if (hit !== undefined) {
        date = hit;
        break;
      }
      path.push(cursor.id);
      if (cursor.date !== null) {
        date = cursor.date;
        break;
      }
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    for (const id of path) dates.set(id, date);
  }
  return dates;
}

/** RxDB の chunk / userTag docs から GraphNode 列（id 昇順）を導出する */
export function nodesFromDocs(
  chunks: readonly ChunkDoc[],
  userTags: readonly ChunkUserTagDoc[],
): GraphNode[] {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const dates = rootDates(chunks, byId);
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
      date: dates.get(c.id) ?? "",
      polarity: c.polarity,
      tags: [],
      userTags: (tagsByChunk.get(c.id) ?? []).toSorted(),
      childCount: 0,
      descendantCount: 0,
    }),
  );
  return recomputeCounts(nodes.toSorted((a, b) => a.id - b.id));
}

/**
 * RxDB の link docs から GraphEdge 列を導出する（#77）。両端が存在するノードの
 * エッジのみ残す（同期途中の孤児・削除済みチャンクへのリンクは表示しない）。
 */
export function edgesFromDocs(links: readonly LinkDoc[], alive: ReadonlySet<number>): GraphEdge[] {
  return links.flatMap((l) => {
    const from = numId(l.fromChunkId);
    const to = numId(l.toChunkId);
    if (!alive.has(from) || !alive.has(to)) return [];
    return [{ from, to, score: l.score, origin: l.origin }];
  });
}
