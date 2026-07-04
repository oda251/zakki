import { create } from "zustand";
import { api } from "@zakki/web/client/api/client.ts";
import type { GraphData, GraphNode, SessionWithTags } from "@zakki/web/shared/api-types.ts";

/**
 * セッション色: dataviz の fixed-order categorical（styles.css の --series-*）。
 * スロットは 8 個。9 個目以降のセッションは neutral に fold し、識別は
 * サイドバー・ツールチップ（secondary encoding）に委ねる（色は循環させない）。
 */
export const SERIES_SLOTS = 8;
export const NODE_NEUTRAL = "var(--node-neutral)";

export function sessionColor(slot: number | undefined): string {
  return slot === undefined ? NODE_NEUTRAL : `var(--series-${slot + 1})`;
}

export interface GraphFilter {
  /** 空 = 全セッション表示 */
  sessionIds: ReadonlySet<number>;
  /** 自動タグ名（完全一致）。null = フィルタなし */
  tag: string | null;
  /** セッションタグ（ユーザ明示タグ）。null = フィルタなし */
  sessionTag: string | null;
}

interface GraphState {
  data: GraphData | null;
  error: string | null;
  filter: GraphFilter;
  selectedNodeId: number | null;
  load: () => Promise<void>;
  toggleSession: (id: number) => void;
  /** グラフをこのセッションだけの表示にする（セッションを開いたときのリセット） */
  focusSession: (id: number) => void;
  clearSessionFilter: () => void;
  setTagFilter: (tag: string | null) => void;
  setSessionTagFilter: (tag: string | null) => void;
  selectNode: (id: number | null) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  data: null,
  error: null,
  filter: { sessionIds: new Set<number>(), tag: null, sessionTag: null },
  selectedNodeId: null,

  load: async () => {
    try {
      const data = await api.graph();
      set({ data, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  toggleSession: (id) => {
    set((s) => {
      const next = new Set(s.filter.sessionIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { filter: { ...s.filter, sessionIds: next } };
    });
  },

  focusSession: (id) => {
    set((s) => ({ filter: { ...s.filter, sessionIds: new Set([id]) } }));
  },

  clearSessionFilter: () => {
    set((s) => ({ filter: { ...s.filter, sessionIds: new Set<number>() } }));
  },

  setTagFilter: (tag) => {
    set((s) => ({ filter: { ...s.filter, tag } }));
  },

  setSessionTagFilter: (tag) => {
    set((s) => ({ filter: { ...s.filter, sessionTag: tag } }));
  },

  selectNode: (id) => {
    set({ selectedNodeId: id });
  },
}));

/** セッション id → series スロット（作成順で固定割当。SERIES_SLOTS 超は undefined = neutral） */
export function seriesSlotBySession(sessions: SessionWithTags[]): Map<number, number> {
  const slots = new Map<number, number>();
  const sorted = [...sessions].toSorted((a, b) => a.id - b.id);
  for (const [index, session] of sorted.entries()) {
    if (index < SERIES_SLOTS) {
      slots.set(session.id, index);
    }
  }
  return slots;
}

/** フィルタ適用後の表示ノード（エッジは両端が可視のもののみ） */
export function visibleGraph(
  data: GraphData,
  filter: GraphFilter,
): { nodes: GraphNode[]; edges: GraphData["edges"] } {
  const bySession = filter.sessionIds.size > 0;
  // セッションタグはセッション単位のフィルタ: タグを持つセッションの id 集合に落とす
  const taggedSessions =
    filter.sessionTag === null
      ? null
      : new Set(
          data.sessions.filter((s) => s.tags.includes(filter.sessionTag ?? "")).map((s) => s.id),
        );
  const nodes = data.nodes.filter(
    (n) =>
      (!bySession || filter.sessionIds.has(n.sessionId)) &&
      (taggedSessions === null || taggedSessions.has(n.sessionId)) &&
      (filter.tag === null || n.tags.includes(filter.tag)),
  );
  const visible = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => visible.has(e.from) && visible.has(e.to));
  return { nodes, edges };
}
