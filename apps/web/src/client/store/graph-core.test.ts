import { describe, expect, test } from "bun:test";
import type { GraphData, GraphEdge, GraphNode } from "@zakki/web/shared/api-types.ts";
import {
  addManualEdges,
  breadcrumbPath,
  EMPTY_FILTER,
  isDoubleClick,
  parentOf,
  recomputeCounts,
  resolveNodeActivation,
  seriesSlotsAtLevel,
  visibleGraph,
} from "./graph-core.ts";

function n(id: number, parentId: number | null, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    parentId,
    position: 0,
    content: `c${id}`,
    date: "2026-07-05",
    polarity: null,
    tags: [],
    userTags: [],
    childCount: 0,
    descendantCount: 0,
    ...over,
  };
}

function edge(from: number, to: number, origin: GraphEdge["origin"] = "auto"): GraphEdge {
  return { from, to, score: 1, origin };
}

function data(nodes: GraphNode[], edges: GraphEdge[] = [], version = "v1"): GraphData {
  return { version, nodes: recomputeCounts(nodes), edges };
}

// ツリー: 日付 1 ─┬─ 2（葉）
//                └─ 3（コンテナ）─ 4（葉）
//         日付 5 ── 6（葉）
const TREE = [n(1, null), n(2, 1), n(3, 1), n(4, 3), n(5, null), n(6, 5)];

describe("visibleGraph", () => {
  test("トップレベル（drillId=null）は日付チャンクだけ", () => {
    const g = visibleGraph(data(TREE), null, EMPTY_FILTER);
    expect(g.nodes.map((v) => v.node.id)).toEqual([1, 5]);
    expect(g.nodes.every((v) => !v.external)).toBe(true);
  });

  test("ドリル中は直下子に閉じる", () => {
    const g = visibleGraph(data(TREE), 1, EMPTY_FILTER);
    expect(g.nodes.map((v) => v.node.id)).toEqual([2, 3]);
  });

  test("セッション外へのリンク先はそのノード自体を external として表示する", () => {
    const g = visibleGraph(data(TREE, [edge(2, 6)]), 1, EMPTY_FILTER);
    expect(g.nodes.map((v) => [v.node.id, v.external])).toEqual([
      [2, false],
      [3, false],
      [6, true],
    ]);
    expect(g.edges).toEqual([edge(2, 6)]);
  });

  test("external 同士のエッジは表示しない", () => {
    // 4↔6 は drill=1 ではどちらも不可視（4 は深い階層）
    const g = visibleGraph(data(TREE, [edge(4, 6)]), 1, EMPTY_FILTER);
    expect(g.nodes.map((v) => v.node.id)).toEqual([2, 3]);
    expect(g.edges).toEqual([]);
  });

  test("chrono エッジはトップレベルで可視ノード同士として残る", () => {
    const g = visibleGraph(data(TREE, [edge(1, 5, "chrono")]), null, EMPTY_FILTER);
    expect(g.edges).toEqual([edge(1, 5, "chrono")]);
  });

  test("タグ・ユーザタグでベース集合を絞る（external は絞らない）", () => {
    const nodes = [n(1, null), n(2, 1, { tags: ["旅"] }), n(3, 1), n(5, null), n(6, 5)];
    const g = visibleGraph(data(nodes, [edge(2, 6)]), 1, { tag: "旅", userTag: null });
    expect(g.nodes.map((v) => [v.node.id, v.external])).toEqual([
      [2, false],
      [6, true],
    ]);
  });
});

describe("breadcrumbPath", () => {
  test("ルート → 現在の祖先列を返す", () => {
    expect(breadcrumbPath(data(TREE), 3).map((x) => x.id)).toEqual([1, 3]);
    expect(breadcrumbPath(data(TREE), null)).toEqual([]);
  });
});

describe("recomputeCounts", () => {
  test("childCount = 直接の子数、descendantCount = 総子孫数", () => {
    const nodes = recomputeCounts(TREE);
    const byId = new Map(nodes.map((x) => [x.id, x]));
    expect(byId.get(1)).toMatchObject({ childCount: 2, descendantCount: 3 });
    expect(byId.get(3)).toMatchObject({ childCount: 1, descendantCount: 1 });
    expect(byId.get(4)).toMatchObject({ childCount: 0, descendantCount: 0 });
  });
});

describe("addManualEdges", () => {
  test("from<to 正規化・重複と自己リンクは no-op", () => {
    const before = data(TREE, [edge(2, 3, "manual")]);
    const after = addManualEdges(before, [
      { from: 3, to: 2 }, // 重複（正規化後 2-3）
      { from: 4, to: 4 }, // 自己
      { from: 6, to: 4 }, // 新規（4-6 へ正規化）
    ]);
    expect(after.edges).toEqual([edge(2, 3, "manual"), { ...edge(4, 6, "manual") }]);
  });
});

describe("resolveNodeActivation / parentOf / isDoubleClick", () => {
  test("コンテナ・日付チャンクは drill、葉は親へ移動 + 選択", () => {
    const d = data(TREE);
    const byId = new Map(d.nodes.map((x) => [x.id, x]));
    expect(resolveNodeActivation(byId.get(3) ?? n(0, null))).toEqual({ kind: "drill", id: 3 });
    expect(resolveNodeActivation(byId.get(1) ?? n(0, null))).toEqual({ kind: "drill", id: 1 });
    expect(resolveNodeActivation(byId.get(4) ?? n(0, null))).toEqual({
      kind: "drillSelect",
      parentId: 3,
      selectId: 4,
    });
  });

  test("parentOf は親 id（トップレベル・未知 id は null）", () => {
    const d = data(TREE);
    expect(parentOf(d, 4)).toBe(3);
    expect(parentOf(d, 1)).toBeNull();
    expect(parentOf(d, 999)).toBeNull();
  });

  test("isDoubleClick は detail=2 または窓内の同一ノード再クリック", () => {
    expect(isDoubleClick(null, 1, 1000, 2)).toBe(true);
    expect(isDoubleClick({ id: 1, at: 900 }, 1, 1000, 1)).toBe(true);
    expect(isDoubleClick({ id: 2, at: 900 }, 1, 1000, 1)).toBe(false);
    expect(isDoubleClick({ id: 1, at: 100 }, 1, 1000, 1)).toBe(false);
  });
});

describe("seriesSlotsAtLevel", () => {
  test("直下コンテナだけに id 昇順でスロットを割る（葉と external は対象外）", () => {
    const visible = visibleGraph(data(TREE, [edge(2, 6)]), 1, EMPTY_FILTER);
    const slots = seriesSlotsAtLevel(visible.nodes);
    expect(slots.get(3)).toBe(0); // コンテナ
    expect(slots.has(2)).toBe(false); // 葉
    expect(slots.has(6)).toBe(false); // external
  });
});
