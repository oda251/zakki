import { create } from "zustand";
import { buildRaw } from "@zakki/core/entry/records.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import { localDate } from "@zakki/core/util/local-date.ts";
import type { ChunkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { childrenQuery, toChunkDoc } from "@zakki/web/client/db/docs.ts";
import { docId, numId } from "@zakki/web/client/db/ids.ts";
import { getOrCreateDateChunkDoc } from "@zakki/web/client/db/writes.ts";

/**
 * Composer が書き込む「現在のバッファ」（＝親チャンク）の状態。
 * どのチャンクを開くかは URL が SSOT（#52）: openToday / openChunk は router の
 * controller が URL 変化に追随して呼ぶ（グラフのドリル位置も URL から導出されるため、
 * ここからグラフ store への手動同期は無い）。
 * 読み出しはローカル RxDB（#44）: リロード時も IndexedDB(Dexie) レプリカから復元する。
 * raw は永続化されないため、子チャンクの content から buildRaw で再構成する。
 * ここに残るのはロード結果（サーバ状態のスナップショット）だけで、URL 化できる
 * ナビゲーション状態は持たない。
 */
interface BufferState {
  /** RxDB（connect で注入。null の間は openToday / openChunk は no-op でエラー表示） */
  db: ZakkiDatabase | null;
  /** 現在のバッファ（親チャンク）の id。ロード完了まで null */
  currentId: number | null;
  /** 子チャンクから再構成した raw（Composer の初期値。ロード完了まで null） */
  initialRaw: string | null;
  /** ロード時点の既存子チャンク id（自動リンクの「新規」判定の基準） */
  initialChunkIds: number[];
  error: string | null;
  /** main.tsx の合成点から一度呼ぶ */
  connect: (db: ZakkiDatabase) => void;
  /** 当日の日付チャンクを開く（URL "/"・"/all"。無ければ作成する） */
  openToday: () => Promise<void>;
  /** 指定チャンクをバッファとして開く（URL "/c/:id"） */
  openChunk: (id: number) => Promise<void>;
}

export const useBufferStore = create<BufferState>((set, get) => {
  const openDoc = async (db: ZakkiDatabase, chunk: ChunkDoc): Promise<void> => {
    const children = await childrenQuery(db, chunk.id);
    set({
      currentId: numId(chunk.id),
      initialRaw: buildRaw(children.map((c) => c.content)),
      initialChunkIds: children.map((c) => numId(c.id)),
      error: null,
    });
  };

  const fail = (e: unknown): void => {
    set({ error: errorMessage(e) });
  };

  return {
    db: null,
    currentId: null,
    initialRaw: null,
    initialChunkIds: [],
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
