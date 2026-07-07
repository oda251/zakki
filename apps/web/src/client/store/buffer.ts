import { create } from "zustand";
import { buildRaw } from "@zakki/core/entry/records.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import { localDate } from "@zakki/core/util/local-date.ts";
import { api } from "@zakki/web/client/api/client.ts";
import type { ChunkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { childrenQuery, toChunkDoc } from "@zakki/web/client/db/docs.ts";
import { docId, numId } from "@zakki/web/client/db/ids.ts";
import { getOrCreateDateChunkDoc } from "@zakki/web/client/db/writes.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import type { RelatedChunk } from "@zakki/web/shared/api-types.ts";

/** 現在のバッファ（親チャンク）。UI が使う素性のみ（id は数値へ写す） */
export interface BufferChunk {
  id: number;
  content: string;
  date: string | null;
}

/**
 * Composer が書き込む「現在のバッファ」（＝親チャンク）の状態。
 * 既定は当日の日付チャンク（TUI と同じ）。グラフのドリルインで任意チャンクの
 * バッファへ切り替わる（docs/CHUNKS.md §入力・保存）。
 * 読み出しはローカル RxDB（#44）: リロード時も IndexedDB(Dexie) レプリカから復元する。
 * raw は永続化されないため、子チャンクの content から buildRaw で再構成する。
 */
interface BufferState {
  /** RxDB（connect で注入。null の間は openToday / openChunk は no-op でエラー表示） */
  db: ZakkiDatabase | null;
  /** 現在のバッファ（親チャンク）。ロード完了まで null */
  current: BufferChunk | null;
  /** 子チャンクから再構成した raw（Composer の初期値。ロード完了まで null） */
  initialRaw: string | null;
  /** ロード時点の既存子チャンク id（自動リンクの「新規」判定の基準） */
  initialChunkIds: number[];
  related: RelatedChunk[];
  error: string | null;
  /** main.tsx の合成点から一度呼ぶ */
  connect: (db: ZakkiDatabase) => void;
  /** 当日の日付チャンクを開く（起動時） */
  openToday: () => Promise<void>;
  /** 指定チャンクをバッファとして開く（グラフのドリルイン） */
  openChunk: (id: number) => Promise<void>;
}

export const useBufferStore = create<BufferState>((set, get) => {
  // 関連（サーバ埋め込み解析の産物）はバッファを開いた時点のみ更新する。
  // 解析はレガシー /api 書込み経路でしか走らないため SSE 再取得は #44 で撤去
  // （クライアント解析の導入は #28/#26）。失敗しても入力を妨げない
  const refreshRelated = async (id: number): Promise<void> => {
    try {
      const res = await api.related(id);
      set({ related: res.items });
    } catch {
      // アンビエント表示。黙って空のままにする
    }
  };

  const openDoc = async (db: ZakkiDatabase, chunk: ChunkDoc): Promise<void> => {
    const children = await childrenQuery(db, chunk.id);
    set({
      current: { id: numId(chunk.id), content: chunk.content, date: chunk.date },
      initialRaw: buildRaw(children.map((c) => c.content)),
      initialChunkIds: children.map((c) => numId(c.id)),
      error: null,
    });
    // グラフはこのバッファの階層をドリル表示する
    useGraphStore.getState().drillTo(numId(chunk.id));
    await refreshRelated(numId(chunk.id));
  };

  const fail = (e: unknown): void => {
    set({ error: errorMessage(e) });
  };

  return {
    db: null,
    current: null,
    initialRaw: null,
    initialChunkIds: [],
    related: [],
    error: null,

    connect: (db) => {
      set({ db });
    },

    openToday: async () => {
      const { db } = get();
      if (db === null) return;
      try {
        await openDoc(db, await getOrCreateDateChunkDoc(db, localDate()));
      } catch (e) {
        fail(e);
      }
    },

    openChunk: async (id) => {
      const { db } = get();
      if (db === null) return;
      try {
        const doc = await db.chunks.findOne(docId(id)).exec();
        if (doc === null) {
          set({ error: `チャンクが存在しません: id=${id}` });
          return;
        }
        await openDoc(db, toChunkDoc(doc));
      } catch (e) {
        fail(e);
      }
    },
  };
});
