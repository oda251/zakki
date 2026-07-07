import { combineLatest } from "rxjs";
import { create } from "zustand";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { chunksView, userTagsView } from "@zakki/web/client/db/live.ts";
import type { GraphData } from "@zakki/web/shared/api-types.ts";
import {
  addManualEdges,
  EMPTY_FILTER,
  type GraphFilter,
  parentOf,
} from "@zakki/web/client/store/graph-core.ts";
import { nodesFromDocs } from "@zakki/web/client/store/graph-docs.ts";

export const NODE_NEUTRAL = "var(--node-neutral)";

export function sessionColor(slot: number | undefined): string {
  return slot === undefined ? NODE_NEUTRAL : `var(--series-${slot + 1})`;
}

/**
 * グラフ状態の zustand ストア（imperative shell）。ノードは RxDB liveQuery 購読
 * （connect）から nodesFromDocs で導出し、手動 fetch / キャッシュを持たない（#44）。
 * エッジ: 意味リンクはサーバ解析の産物で replication 対象外のため、当面は
 * 数珠繋ぎ（addManualEdges）のセッションローカル分のみ（links コレクションは将来）。
 */
interface GraphState {
  data: GraphData | null;
  error: string | null;
  /** ドリル中チャンク id。null = トップレベル（日付チャンク層） */
  drillId: number | null;
  filter: GraphFilter;
  selectedNodeId: number | null;
  /** RxDB 購読を開始する（main.tsx の合成点から一度呼ぶ）。戻り値は購読解除 */
  connect: (db: ZakkiDatabase) => () => void;
  /** 起動失敗（bootstrap 例外）の表示。connect 前に UI へエラーを出す唯一の経路 */
  fail: (message: string) => void;
  /** 数珠繋ぎリンクの即時反映（セッションローカル） */
  addManualEdges: (links: readonly { from: number; to: number }[]) => void;
  /** チャンクの中へ潜る（dblclick）。selectId 指定時はそのノードを選択状態にする */
  drillTo: (id: number | null, selectId?: number | null) => void;
  /** 親階層へ戻る（Escape） */
  drillUp: () => void;
  setTagFilter: (tag: string | null) => void;
  setUserTagFilter: (tag: string | null) => void;
  selectNode: (id: number | null) => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  data: null,
  error: null,
  drillId: null,
  filter: EMPTY_FILTER,
  selectedNodeId: null,

  connect: (db) => {
    const sub = combineLatest([chunksView(db), userTagsView(db)]).subscribe({
      next: ([chunks, userTags]) => {
        set((s) => {
          const nodes = nodesFromDocs(chunks, userTags);
          // 手動エッジは doc 再 emit を跨いで維持し、消えたノードのものだけ落とす
          const alive = new Set(nodes.map((n) => n.id));
          const edges = (s.data?.edges ?? []).filter((e) => alive.has(e.from) && alive.has(e.to));
          return { data: { version: "", nodes, edges }, error: null };
        });
      },
      error: (e: unknown) => {
        set({ error: e instanceof Error ? e.message : String(e) });
      },
    });
    return () => sub.unsubscribe();
  },

  fail: (message) => {
    set({ error: message });
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
