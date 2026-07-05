import { create } from "zustand";
import { api } from "@zakki/web/client/api/client.ts";
import type {
  GraphData,
  GraphDelta,
  GraphEdge,
  GraphNode,
  SessionWithTags,
} from "@zakki/web/shared/api-types.ts";

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
  /** SSE（解析完了）後の再取得。前回 version からの差分だけを受けてマージする。初回は全量 */
  loadDelta: () => Promise<void>;
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

export const useGraphStore = create<GraphState>((set, get) => ({
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

  loadDelta: async () => {
    const { data, load } = get();
    // version="" は空 DB 起動直後（初回保存前）の getGraph 応答。since には使えないので全量 load
    if (data === null || data.version === "") return load();
    try {
      const delta = await api.graphDelta(data.version);
      // マージ基準は応答受信時点の data（取得中の applySaved 等の楽観的更新を上書きしない）
      set((s) => (s.data === null ? s : { data: mergeDelta(s.data, delta), error: null }));
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
      const added: GraphEdge[] = [];
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

/**
 * 差分応答を全量データへマージする純関数（差分適用後 = 全量取得後、が不変条件）。
 * - nodes: 変更分は置換・aliveNodeIds に無い id は削除・残りは温存（id 昇順に正規化）
 * - sessionName はノードに非正規化されているため、全量で届く sessions から引き直す（改名反映）
 * - edges / sessions は差分側で全置換
 * - version は差分側を採用するが、現在値より過去（文字列比較で小さい）なら現在値を維持する
 *   （並行 loadDelta の応答順序逆転で since が過去に戻り、以後の差分取得が過剰送信になるのを防ぐ）
 */
export function mergeDelta(data: GraphData, delta: GraphDelta): GraphData {
  const changed = new Map(delta.nodes.map((n) => [n.id, n]));
  const alive = new Set(delta.aliveNodeIds);
  const nameBySession = new Map(delta.sessions.map((s) => [s.id, s.name]));
  const kept = data.nodes.filter((n) => alive.has(n.id) && !changed.has(n.id));
  const nodes = [...kept, ...delta.nodes]
    .toSorted((a, b) => a.id - b.id)
    .map((n) => {
      const sessionName = nameBySession.get(n.sessionId) ?? null;
      return n.sessionName === sessionName ? n : { ...n, sessionName };
    });
  const version = delta.version < data.version ? data.version : delta.version;
  return { version, nodes, edges: delta.edges, sessions: delta.sessions };
}

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
