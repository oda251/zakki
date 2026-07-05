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

/** applySaved に渡す現セッションの素性（ノード生成に必要な最小限） */
export interface SavedSession {
  id: number;
  name: string | null;
  date: string;
}

interface GraphState {
  data: GraphData | null;
  error: string | null;
  filter: GraphFilter;
  selectedNodeId: number | null;
  load: () => Promise<void>;
  /**
   * 保存応答のチャンク列をグラフへ即時反映する（楽観的更新）。
   * サーバ解析（タグ・極性・意味リンク）は待たず、既存ノードの解析結果は温存する。
   * 応答はセッションの全チャンクなので、応答に無い同セッションノードは削除とみなす。
   */
  applySaved: (session: SavedSession, chunks: readonly { id: number; content: string }[]) => void;
  /** 数珠繋ぎリンクの即時反映。data 層 addManualLink と同じ不変条件（from<to・重複/自己は no-op） */
  addManualEdges: (links: readonly { from: number; to: number }[]) => void;
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

  applySaved: (session, chunks) => {
    set((s) => {
      if (s.data === null) return s;
      const existing = new Map(s.data.nodes.map((n) => [n.id, n]));
      const sessionNodes = chunks.map((c): GraphNode => {
        const prev = existing.get(c.id);
        return prev !== undefined
          ? { ...prev, content: c.content }
          : {
              id: c.id,
              content: c.content,
              date: session.date,
              sessionId: session.id,
              sessionName: session.name,
              polarity: null,
              tags: [],
            };
      });
      const kept = s.data.nodes.filter((n) => n.sessionId !== session.id);
      const nodes = [...kept, ...sessionNodes].toSorted((a, b) => a.id - b.id);
      const alive = new Set(nodes.map((n) => n.id));
      const edges = s.data.edges.filter((e) => alive.has(e.from) && alive.has(e.to));
      return { data: { ...s.data, nodes, edges } };
    });
  },

  addManualEdges: (drafts) => {
    set((s) => {
      if (s.data === null) return s;
      const seen = new Set(s.data.edges.map((e) => `${e.from}-${e.to}`));
      const added = [];
      for (const d of drafts) {
        if (d.from === d.to) continue;
        const [from, to] = d.from < d.to ? [d.from, d.to] : [d.to, d.from];
        const key = `${from}-${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        added.push({ from, to, score: 1, origin: "manual" as const });
      }
      return added.length === 0 ? s : { data: { ...s.data, edges: [...s.data.edges, ...added] } };
    });
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
