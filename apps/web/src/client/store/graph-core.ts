import type { GraphData, GraphEdge, GraphNode } from "@zakki/web/shared/api-types.ts";

/**
 * グラフ表示の純粋ロジック（functional core）。zustand ストア（graph.ts）は
 * ここの純関数へ状態遷移を委譲し、自身は配線（API 呼び出し・購読）だけを持つ。
 * ドリル表示・差分マージ・楽観的更新はすべて (data, 入力) → data の純関数。
 */

export interface GraphFilter {
  /** 自動タグ名（完全一致）。null = フィルタなし */
  tag: string | null;
  /** ユーザ明示タグ。null = フィルタなし */
  userTag: string | null;
}

export const EMPTY_FILTER: GraphFilter = { tag: null, userTag: null };

/** 表示ノード。external = ドリル階層の外だがリンクで引き込まれたノード */
export interface VisibleNode {
  node: GraphNode;
  external: boolean;
}

/**
 * ドリル中チャンク drillId（null = トップレベル = 日付チャンク層）の表示グラフ。
 * ベースは直下子に閉じ、表示中ノードからセッション外のノードへリンクがある場合は
 * そのノード自体を external として含める（docs/CHUNKS.md §導出値と描画, 2026-07-06 改訂）。
 * エッジは「可視ノード同士」または「可視 ↔ external」のみ。external 同士は結ばない。
 */
export function visibleGraph(
  data: GraphData,
  drillId: number | null,
  filter: GraphFilter,
): { nodes: VisibleNode[]; edges: GraphEdge[] } {
  const base = data.nodes.filter(
    (n) =>
      n.parentId === drillId &&
      (filter.tag === null || n.tags.includes(filter.tag)) &&
      (filter.userTag === null || n.userTags.includes(filter.userTag)),
  );
  const baseIds = new Set(base.map((n) => n.id));
  const byId = new Map(data.nodes.map((n) => [n.id, n]));

  // 外部リンク先の引き込み: 片端だけが可視のエッジの相手を external として表示する
  const externalIds = new Set<number>();
  for (const e of data.edges) {
    const fromIn = baseIds.has(e.from);
    const toIn = baseIds.has(e.to);
    if (fromIn === toIn) continue;
    const outer = fromIn ? e.to : e.from;
    if (byId.has(outer)) externalIds.add(outer);
  }

  const nodes: VisibleNode[] = [
    ...base.map((node) => ({ node, external: false })),
    ...[...externalIds].flatMap((id) => {
      const node = byId.get(id);
      return node === undefined ? [] : [{ node, external: true }];
    }),
  ];
  const edges = data.edges.filter((e) => {
    const fromBase = baseIds.has(e.from);
    const toBase = baseIds.has(e.to);
    if (fromBase && toBase) return true;
    return (fromBase && externalIds.has(e.to)) || (toBase && externalIds.has(e.from));
  });
  return { nodes, edges };
}

/** 親チャンク id の解決（無ければ null）。Escape の戻り先・drillUp が共有する */
export function parentOf(data: GraphData, id: number): number | null {
  return data.nodes.find((n) => n.id === id)?.parentId ?? null;
}

/**
 * ノードのダブルクリック起動の遷移先（docs/CHUNKS.md §ナビゲーション）。
 * - コンテナ / 日付チャンク → その中へ潜る（バッファ切替）
 * - 葉（external 含む）→ 所属セッション（親バッファ）へ移動し当該ノードを選択
 */
export type NodeActivation =
  | { kind: "drill"; id: number }
  | { kind: "drillSelect"; parentId: number; selectId: number };

export function resolveNodeActivation(node: GraphNode): NodeActivation {
  if (node.childCount > 0 || node.parentId === null) {
    return { kind: "drill", id: node.id };
  }
  return { kind: "drillSelect", parentId: node.parentId, selectId: node.id };
}

/** 同一ノードの 2 連続クリックをダブルクリックとみなす窓（event.detail 不達時の保険） */
export const DOUBLE_CLICK_MS = 350;

export interface ClickStamp {
  id: number;
  at: number;
}

export function isDoubleClick(
  prev: ClickStamp | null,
  id: number,
  at: number,
  detail: number,
  windowMs: number = DOUBLE_CLICK_MS,
): boolean {
  return detail === 2 || (prev !== null && prev.id === id && at - prev.at < windowMs);
}

/** ドリル位置までの祖先列（ルート → 現在）。パンくずリストの素 */
export function breadcrumbPath(data: GraphData, drillId: number | null): GraphNode[] {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const path: GraphNode[] = [];
  let cursor = drillId;
  while (cursor !== null) {
    const node = byId.get(cursor);
    if (node === undefined) break;
    path.unshift(node);
    cursor = node.parentId;
  }
  return path;
}

/**
 * childCount / descendantCount をクライアント側で再導出する（楽観的更新の後処理）。
 * サーバの再帰 CTE と同じ定義。O(n) の親マップ走査。
 */
export function recomputeCounts(nodes: readonly GraphNode[]): GraphNode[] {
  const childCount = new Map<number, number>();
  const parentById = new Map<number, number | null>();
  for (const n of nodes) {
    parentById.set(n.id, n.parentId);
    if (n.parentId !== null) {
      childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    }
  }
  const descendantCount = new Map<number, number>();
  for (const n of nodes) {
    let cursor = parentById.get(n.id) ?? null;
    while (cursor !== null && cursor !== undefined) {
      descendantCount.set(cursor, (descendantCount.get(cursor) ?? 0) + 1);
      cursor = parentById.get(cursor) ?? null;
    }
  }
  return nodes.map((n) => {
    const cc = childCount.get(n.id) ?? 0;
    const dc = descendantCount.get(n.id) ?? 0;
    return n.childCount === cc && n.descendantCount === dc
      ? n
      : { ...n, childCount: cc, descendantCount: dc };
  });
}

/** 数珠繋ぎリンクの即時反映。data 層 addManualLink と同じ不変条件（from<to・重複/自己は no-op） */
export function addManualEdges(
  data: GraphData,
  drafts: readonly { from: number; to: number }[],
): GraphData {
  const seen = new Set(data.edges.map((e) => `${e.from}-${e.to}`));
  const added: GraphEdge[] = [];
  for (const d of drafts) {
    if (d.from === d.to) continue;
    const [from, to] = d.from < d.to ? [d.from, d.to] : [d.to, d.from];
    const key = `${from}-${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ from, to, score: 1, origin: "manual" });
  }
  return added.length === 0 ? data : { ...data, edges: [...data.edges, ...added] };
}

/** series スロット数（styles.css の --series-*） */
export const SERIES_SLOTS = 8;

/**
 * 表示階層の直下コンテナ（childCount > 0）へ series スロットを id 昇順で固定割当する。
 * SERIES_SLOTS 超は undefined（= neutral）。葉・external も undefined。
 */
export function seriesSlotsAtLevel(visible: readonly VisibleNode[]): Map<number, number> {
  const containers = visible
    .filter((v) => !v.external && v.node.childCount > 0)
    .map((v) => v.node.id)
    .toSorted((a, b) => a - b);
  const slots = new Map<number, number>();
  for (const [index, id] of containers.entries()) {
    if (index < SERIES_SLOTS) slots.set(id, index);
  }
  return slots;
}
