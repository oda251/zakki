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

describe("applySaved（保存応答の楽観的反映）", () => {
  const session = { id: 100, name: null, date: "2026-07-05" };

  test("新規チャンクがノードとして即時追加される（tags 空・polarity null）", () => {
    useGraphStore.getState().applySaved(session, [
      { id: 1, content: "本文1" },
      { id: 2, content: "本文2" },
      { id: 9, content: "新規" },
    ]);
    const data = useGraphStore.getState().data;
    expect(data?.nodes.map((n) => n.id)).toEqual([1, 2, 3, 9]);
    const added = data?.nodes.find((n) => n.id === 9);
    expect(added).toEqual({
      id: 9,
      content: "新規",
      date: "2026-07-05",
      sessionId: 100,
      sessionName: null,
      polarity: null,
      tags: [],
    });
  });

  test("既存ノードは tags・polarity を温存しつつ本文を更新する", () => {
    useGraphStore.setState({
      data: {
        ...DATA,
        nodes: [{ ...node(1, 100), tags: ["web"], polarity: 0.5 }, node(2, 100), node(3, 200)],
      },
    });
    useGraphStore.getState().applySaved(session, [
      { id: 1, content: "修正済み" },
      { id: 2, content: "本文2" },
    ]);
    const updated = useGraphStore.getState().data?.nodes.find((n) => n.id === 1);
    expect(updated?.content).toBe("修正済み");
    expect(updated?.tags).toEqual(["web"]);
    expect(updated?.polarity).toBe(0.5);
  });

  test("応答に無い同セッションのチャンクはノードごと消え、参照エッジも落ちる", () => {
    useGraphStore.getState().applySaved(session, [{ id: 1, content: "本文1" }]); // 2 を削除
    const data = useGraphStore.getState().data;
    expect(data?.nodes.map((n) => n.id)).toEqual([1, 3]);
    expect(data?.edges).toEqual([]); // 1-2, 2-3 とも 2 を参照していたので消える
  });

  test("他セッションのノードには触れない", () => {
    useGraphStore.getState().applySaved(session, [
      { id: 1, content: "本文1" },
      { id: 2, content: "本文2" },
    ]);
    expect(useGraphStore.getState().data?.nodes.find((n) => n.id === 3)).toBeDefined();
  });

  test("data 未ロード時は no-op（初回 load に任せる）", () => {
    useGraphStore.setState({ data: null });
    useGraphStore.getState().applySaved(session, [{ id: 1, content: "本文1" }]);
    expect(useGraphStore.getState().data).toBeNull();
  });
});

describe("addManualEdges（数珠繋ぎリンクの楽観的反映）", () => {
  test("from<to へ正規化し score=1 origin=manual で追加する", () => {
    useGraphStore.getState().addManualEdges([{ from: 3, to: 1 }]);
    expect(useGraphStore.getState().data?.edges.at(-1)).toEqual({
      from: 1,
      to: 3,
      score: 1,
      origin: "manual",
    });
  });

  test("既存ペア・自己リンクは追加しない（data 層の不変条件と同じ）", () => {
    useGraphStore.getState().addManualEdges([
      { from: 2, to: 1 }, // 既存 1-2
      { from: 3, to: 3 }, // 自己リンク
    ]);
    expect(useGraphStore.getState().data?.edges).toHaveLength(2);
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
