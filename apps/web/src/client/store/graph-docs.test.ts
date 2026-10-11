import { describe, expect, test } from "bun:test";
import type { ChunkDoc, ChunkUserTagDoc } from "@zakki/web/client/db/database.ts";
import { nodesFromDocs } from "@zakki/web/client/store/graph-docs.ts";

/**
 * issue #44: RxDB chunk docs → GraphNode[] の純導出。
 * サーバ getGraph（graph/queries.ts）の投影と同じ形（root date 継承・派生値）を
 * クライアント側で再現する。自動タグ（chunk_tags）は replication 対象外のため空。
 */
const chunk = (over: Partial<ChunkDoc> & { id: string }): ChunkDoc => ({
  parentId: null,
  position: 0,
  content: "本文",
  date: null,
  polarity: null,
  updatedAt: "2026-07-07T00:00:00.000Z",
  ...over,
});

const tag = (id: string, chunkId: string, name: string): ChunkUserTagDoc => ({
  id,
  chunkId,
  name,
  updatedAt: "2026-07-07T00:00:00.000Z",
});

describe("nodesFromDocs", () => {
  test("数値 id・parentId・root date 継承で GraphNode へ写す", () => {
    const nodes = nodesFromDocs(
      [
        chunk({ id: "900000020260707", content: "2026-07-07", date: "2026-07-07" }),
        chunk({ id: "10", parentId: "900000020260707", position: 0, content: "親" }),
        chunk({ id: "11", parentId: "10", position: 0, content: "孫", polarity: 0.5 }),
      ],
      [],
    );
    expect(nodes.map((n) => n.id)).toEqual([10, 11, 900_000_020_260_707]);
    const grandchild = nodes.find((n) => n.id === 11);
    expect(grandchild?.parentId).toBe(10);
    expect(grandchild?.date).toBe("2026-07-07");
    expect(grandchild?.polarity).toBe(0.5);
    expect(nodes.find((n) => n.id === 900_000_020_260_707)?.parentId).toBeNull();
  });

  test("childCount / descendantCount を再導出する", () => {
    const nodes = nodesFromDocs(
      [
        chunk({ id: "1", content: "2026-07-07", date: "2026-07-07" }),
        chunk({ id: "2", parentId: "1" }),
        chunk({ id: "3", parentId: "2" }),
      ],
      [],
    );
    const root = nodes.find((n) => n.id === 1);
    expect(root?.childCount).toBe(1);
    expect(root?.descendantCount).toBe(2);
    expect(nodes.find((n) => n.id === 3)?.childCount).toBe(0);
  });

  test("userTags を chunkId で付与し、自動タグ tags は空", () => {
    const nodes = nodesFromDocs(
      [chunk({ id: "1", date: "2026-07-07", content: "2026-07-07" })],
      [tag("t1", "1", "b"), tag("t2", "1", "a"), tag("t3", "999", "無関係")],
    );
    expect(nodes[0]?.userTags).toEqual(["a", "b"]);
    expect(nodes[0]?.tags).toEqual([]);
  });

  test("祖先に日付チャンクが無いノードは date が空文字になる", () => {
    const nodes = nodesFromDocs([chunk({ id: "5", parentId: "存在しない親" })], []);
    expect(nodes[0]?.date).toBe("");
  });
});
