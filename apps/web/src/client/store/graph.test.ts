import { beforeEach, describe, expect, test } from "bun:test";
import type { GraphData } from "@zakki/web/shared/api-types.ts";
import { useGraphStore, visibleGraph } from "./graph.ts";

const node = (id: number, sessionId: number) => ({
  id,
  content: `本文${id}`,
  date: "2026-07-05",
  sessionId,
  sessionName: null,
  polarity: null,
  tags: [],
});

const DATA: GraphData = {
  nodes: [node(1, 100), node(2, 100), node(3, 200)],
  edges: [
    { from: 1, to: 2, score: 0.9, origin: "auto" },
    { from: 2, to: 3, score: 0.9, origin: "auto" },
  ],
  sessions: [
    { id: 100, name: null, date: "2026-07-05", createdAt: "", updatedAt: "", tags: [] },
    { id: 200, name: "調査", date: "2026-07-05", createdAt: "", updatedAt: "", tags: [] },
  ],
};

beforeEach(() => {
  useGraphStore.setState({
    data: DATA,
    filter: { sessionIds: new Set<number>(), tag: null, sessionTag: null },
    selectedNodeId: null,
  });
});

describe("focusSession（セッション単位表示）", () => {
  test("filter.sessionIds がそのセッションだけに置き換わる", () => {
    useGraphStore.getState().toggleSession(200); // 既存フィルタがあっても
    useGraphStore.getState().focusSession(100);
    expect([...useGraphStore.getState().filter.sessionIds]).toEqual([100]);
  });

  test("他のフィルタ（自動タグ・セッションタグ）は温存する", () => {
    useGraphStore.getState().setTagFilter("web");
    useGraphStore.getState().focusSession(100);
    expect(useGraphStore.getState().filter.tag).toBe("web");
  });
});

describe("visibleGraph（セッション絞り込みの回帰）", () => {
  test("sessionIds={100} のとき 100 のノードのみ・両端可視のエッジのみ", () => {
    const { nodes, edges } = visibleGraph(DATA, {
      sessionIds: new Set([100]),
      tag: null,
      sessionTag: null,
    });
    expect(nodes.map((n) => n.id)).toEqual([1, 2]);
    expect(edges).toEqual([{ from: 1, to: 2, score: 0.9, origin: "auto" }]);
  });
});
