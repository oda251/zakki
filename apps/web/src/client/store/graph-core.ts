import type { GraphData, GraphDelta, GraphEdge, GraphNode } from "@zakki/web/shared/api-types.ts";

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
  const parentOf = new Map<number, number | null>();
  for (const n of nodes) {
    parentOf.set(n.id, n.parentId);
    if (n.parentId !== null) {
      childCount.set(n.parentId, (childCount.get(n.parentId) ?? 0) + 1);
    }
  }
  const descendantCount = new Map<number, number>();
  for (const n of nodes) {
    let cursor = parentOf.get(n.id) ?? null;
    while (cursor !== null && cursor !== undefined) {
      descendantCount.set(cursor, (descendantCount.get(cursor) ?? 0) + 1);
      cursor = parentOf.get(cursor) ?? null;
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

/**
 * 保存応答（親バッファの全子チャンク）をグラフへ即時反映する（楽観的更新）。
 * サーバ解析（タグ・極性・意味リンク）は待たず、既存ノードの解析結果は温存する。
 * 応答に無い旧・子ノードは削除とみなし、その子孫ごと落とす（投影の破壊性と同型）。
 * 派生値（childCount / descendantCount）は再導出する。
 */
export function applySavedChildren(
  data: GraphData,
  parent: { id: number; date: string },
  children: readonly { id: number; content: string }[],
): GraphData {
  const existing = new Map(data.nodes.map((n) => [n.id, n]));
  const savedNodes = children.map((c, position): GraphNode => {
    const prev = existing.get(c.id);
    return prev !== undefined
      ? { ...prev, content: c.content, position }
      : {
          id: c.id,
          parentId: parent.id,
          position,
          content: c.content,
          date: parent.date,
          polarity: null,
          tags: [],
          userTags: [],
          childCount: 0,
          descendantCount: 0,
        };
  });

  // 削除された旧・子とその子孫を落とす
  const savedIds = new Set(savedNodes.map((n) => n.id));
  const removedRoots = data.nodes.filter((n) => n.parentId === parent.id && !savedIds.has(n.id));
  const removed = new Set(removedRoots.map((n) => n.id));
  let grew = removed.size > 0;
  while (grew) {
    grew = false;
    for (const n of data.nodes) {
      if (n.parentId !== null && removed.has(n.parentId) && !removed.has(n.id)) {
        removed.add(n.id);
        grew = true;
      }
    }
  }

  const kept = data.nodes.filter(
    (n) => n.parentId !== parent.id && !removed.has(n.id) && !savedIds.has(n.id),
  );
  const nodes = recomputeCounts([...kept, ...savedNodes].toSorted((a, b) => a.id - b.id));
  const alive = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => alive.has(e.from) && alive.has(e.to));
  return { ...data, nodes, edges };
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

/**
 * 差分応答を全量データへマージする純関数（差分適用後 = 全量取得後、が不変条件）。
 * - nodes: 変更分は置換・aliveNodes に無い id は削除・残りは温存（id 昇順に正規化）。
 *   温存ノードの派生値（childCount / descendantCount）は aliveNodes の値で更新する
 *   （子の追加は親の updatedAt を動かさないため、派生値だけが動くノードがある）
 * - edges は差分側で全置換
 * - version は差分側を採用するが、現在値より過去（文字列比較で小さい）なら現在値を維持する
 *   （並行 loadDelta の応答順序逆転で since が過去に戻り、以後の差分取得が過剰送信になるのを防ぐ）
 */
export function mergeDelta(data: GraphData, delta: GraphDelta): GraphData {
  const changed = new Map(delta.nodes.map((n) => [n.id, n]));
  const alive = new Map(delta.aliveNodes.map((a) => [a.id, a]));
  const kept = data.nodes
    .filter((n) => alive.has(n.id) && !changed.has(n.id))
    .map((n) => {
      const a = alive.get(n.id);
      if (a === undefined) return n;
      return n.childCount === a.childCount && n.descendantCount === a.descendantCount
        ? n
        : { ...n, childCount: a.childCount, descendantCount: a.descendantCount };
    });
  const nodes = [...kept, ...delta.nodes].toSorted((a, b) => a.id - b.id);
  const version = delta.version < data.version ? data.version : delta.version;
  return { version, nodes, edges: delta.edges };
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
