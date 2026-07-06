import { create } from "zustand";
import { api } from "@zakki/web/client/api/client.ts";
import type { GraphData } from "@zakki/web/shared/api-types.ts";
import {
  addManualEdges,
  applySavedChildren,
  EMPTY_FILTER,
  type GraphFilter,
  mergeDelta,
  parentOf,
} from "@zakki/web/client/store/graph-core.ts";

export const NODE_NEUTRAL = "var(--node-neutral)";

export function sessionColor(slot: number | undefined): string {
  return slot === undefined ? NODE_NEUTRAL : `var(--series-${slot + 1})`;
}

/**
 * グラフ状態の zustand ストア（imperative shell）。状態遷移は graph-core.ts の
 * 純関数へ委譲し、ここは API 呼び出し・エラー写像・購読の配線だけを持つ。
 */
interface GraphState {
  data: GraphData | null;
  error: string | null;
  /** ドリル中チャンク id。null = トップレベル（日付チャンク層） */
  drillId: number | null;
  filter: GraphFilter;
  selectedNodeId: number | null;
  load: () => Promise<void>;
  /** SSE（解析完了）後の再取得。前回 version からの差分だけを受けてマージする。初回は全量 */
  loadDelta: () => Promise<void>;
  /** 保存応答の子チャンク列をグラフへ即時反映する（楽観的更新） */
  applySaved: (
    parent: { id: number; date: string },
    children: readonly { id: number; content: string }[],
  ) => void;
  /** 数珠繋ぎリンクの即時反映 */
  addManualEdges: (links: readonly { from: number; to: number }[]) => void;
  /** チャンクの中へ潜る（dblclick）。selectId 指定時はそのノードを選択状態にする */
  drillTo: (id: number | null, selectId?: number | null) => void;
  /** 親階層へ戻る（Escape） */
  drillUp: () => void;
  setTagFilter: (tag: string | null) => void;
  setUserTagFilter: (tag: string | null) => void;
  selectNode: (id: number | null) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  data: null,
  error: null,
  drillId: null,
  filter: EMPTY_FILTER,
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

  applySaved: (parent, children) => {
    set((s) => (s.data === null ? s : { data: applySavedChildren(s.data, parent, children) }));
  },

  addManualEdges: (drafts) => {
    set((s) => (s.data === null ? s : { data: addManualEdges(s.data, drafts) }));
  },

  drillTo: (id, selectId = null) => {
    set({ drillId: id, selectedNodeId: selectId });
  },

  drillUp: () => {
    set((s) => {
      if (s.drillId === null) return s;
      // 現在のドリル位置を選択状態で親階層へ戻る（どこから戻ったか分かるように）
      const parentId = s.data === null ? null : parentOf(s.data, s.drillId);
      return { drillId: parentId, selectedNodeId: s.drillId };
    });
  },

  setTagFilter: (tag) => {
    set((s) => ({ filter: { ...s.filter, tag } }));
  },

  setUserTagFilter: (userTag) => {
    set((s) => ({ filter: { ...s.filter, userTag } }));
  },

  selectNode: (id) => {
    set({ selectedNodeId: id });
  },
}));
