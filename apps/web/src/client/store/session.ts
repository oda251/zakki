import { create } from "zustand";
import { api } from "@zakki/web/client/api/client.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import type { RelatedChunk, Session } from "@zakki/web/shared/api-types.ts";

/**
 * Composer が書き込む「現在のセッション」の状態。
 * 既定は当日のデフォルトセッション（TUI と同じ）。グラフのノードから
 * 別セッションへジャンプできる（Phase 6 で名前付きセッションの作成 UI が載る）。
 */
interface SessionState {
  current: Session | null;
  /** 現セッションの entry.raw（Composer の初期値。ロード完了まで null） */
  initialRaw: string | null;
  related: RelatedChunk[];
  error: string | null;
  /** 当日のデフォルトセッションを開く（起動時） */
  openToday: () => Promise<void>;
  /** 指定セッションを開く（グラフからのジャンプ・Phase 6 の一覧選択） */
  openSession: (id: number) => Promise<void>;
  refreshRelated: () => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => {
  const load = async (session: Session): Promise<void> => {
    const entry = await api.sessionEntry(session.id);
    set({ current: session, initialRaw: entry.entry?.raw ?? "", error: null });
    // グラフはセッション単位表示: 開いたセッションだけにフィルタをリセットする
    useGraphStore.getState().focusSession(session.id);
    await get().refreshRelated();
  };
  return {
    current: null,
    initialRaw: null,
    related: [],
    error: null,

    openToday: async () => {
      try {
        await load(await api.defaultSession());
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    openSession: async (id) => {
      try {
        const sessions = await api.sessions();
        const session = sessions.find((s) => s.id === id);
        if (session === undefined) {
          set({ error: `セッションが見つかりません: id=${id}` });
          return;
        }
        await load(session);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    refreshRelated: async () => {
      const { current } = get();
      if (current === null) return;
      try {
        const res = await api.related(current.id);
        set({ related: res.items });
      } catch {
        // 関連はアンビエント表示。失敗しても入力を妨げない
      }
    },
  };
});
