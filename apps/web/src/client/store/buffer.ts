import { create } from "zustand";
import { buildRaw } from "@zakki/core/entry/records.ts";
import { api } from "@zakki/web/client/api/client.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import type { Chunk, RelatedChunk } from "@zakki/web/shared/api-types.ts";

/**
 * Composer が書き込む「現在のバッファ」（＝親チャンク）の状態。
 * 既定は当日の日付チャンク（TUI と同じ）。グラフのドリルインで任意チャンクの
 * バッファへ切り替わる（docs/CHUNKS.md §入力・保存）。
 * raw はサーバに保存されないため、子チャンクの content から buildRaw で再構成する。
 */
interface BufferState {
  /** 現在のバッファ（親チャンク）。ロード完了まで null */
  current: Chunk | null;
  /** 子チャンクから再構成した raw（Composer の初期値。ロード完了まで null） */
  initialRaw: string | null;
  /** ロード時点の既存子チャンク id（自動リンクの「新規」判定の基準） */
  initialChunkIds: number[];
  related: RelatedChunk[];
  error: string | null;
  /** 当日の日付チャンクを開く（起動時） */
  openToday: () => Promise<void>;
  /** 指定チャンクをバッファとして開く（グラフのドリルイン） */
  openChunk: (id: number) => Promise<void>;
  refreshRelated: () => Promise<void>;
}

export const useBufferStore = create<BufferState>((set, get) => {
  const load = async (id: number): Promise<void> => {
    const { chunk, children } = await api.chunkChildren(id);
    set({
      current: chunk,
      initialRaw: buildRaw(children.map((c) => c.content)),
      initialChunkIds: children.map((c) => c.id),
      error: null,
    });
    // グラフはこのバッファの階層をドリル表示する
    useGraphStore.getState().drillTo(chunk.id);
    await get().refreshRelated();
  };
  return {
    current: null,
    initialRaw: null,
    initialChunkIds: [],
    related: [],
    error: null,

    openToday: async () => {
      try {
        const date = await api.dateChunk();
        await load(date.id);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    openChunk: async (id) => {
      try {
        await load(id);
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
