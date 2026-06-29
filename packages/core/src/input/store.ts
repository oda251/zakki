import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { applyEditKey as applyEditKeyPure } from "./controller.ts";
import type { Cursor, CursorState, KeyLike } from "./controller.ts";

/**
 * 修正対象の指定（docs/PANES.md §7）。
 * - main: 当日 raw 内のリテラル領域 [start, end)（メインペインの確定チャンク）。
 * - detail: 詳細ペインの過去/当日チャンク。commit 時に date+position から領域を再解決する。
 */
export type EditTarget =
  | { kind: "main"; start: number; end: number }
  | { kind: "detail"; date: string; position: number; chunkId: number };

/**
 * 修正中の確定チャンク（記録モデル, docs/RECORDS.md）。
 * raw 内のリテラル領域を、プレーンテキスト＋可動カーソル（CursorState）で打ち直す（再変換しない）。
 */
export interface Editing extends CursorState {
  /** 編集対象（メイン or 詳細） */
  target: EditTarget;
  /** 参照表示する元の確定テキスト（空のまま確定すると元に戻す＝削除しない） */
  old: string;
}

/**
 * 入力の論理状態（platform 非依存・headless, docs/COMPOSER.md 軸2）。
 * opentui/DOM を一切参照しない。視覚系（scrollbox・native-cursor・width）は platform 層に置く。
 */
export interface EditorState {
  /** 入力の正本（ローマ字打鍵ログ＋凍結リテラル）。旧 bufferRef の置き換え */
  raw: string;
  /** 非同期変換の確定で増やし、再描画・再保存を駆動する。旧 conversionVersion */
  conversionVersion: number;
  /** 単一グローバルカーソル（docs/PANES.md §3）。旧 cursorRef の置き換え */
  cursor: Cursor;
  /** 確定チャンクの修正（null なら通常入力）。旧 editRef ＋ editing state の統合 */
  editing: Editing | null;
}

export interface EditorActions {
  setRaw: (raw: string) => void;
  bumpConversion: () => void;
  setCursor: (cursor: Cursor) => void;
  setEditing: (editing: Editing | null) => void;
  /** 修正モードのキー操作を editing に適用する（editing が null なら no-op） */
  applyEditKey: (key: KeyLike) => void;
}

export type EditorStore = EditorState & EditorActions;

/**
 * 入力の論理状態 store を生成する（vanilla。React 束縛は各 app が useStore で行う）。
 * 同一 tick の連続キーは getState() で同期に読めるため、旧来の ref 二重持ちは不要。
 */
export function createEditorStore(
  init: Pick<EditorState, "raw" | "cursor">,
): StoreApi<EditorStore> {
  return createStore<EditorStore>((set) => ({
    raw: init.raw,
    conversionVersion: 0,
    cursor: init.cursor,
    editing: null,
    setRaw: (raw) => set({ raw }),
    bumpConversion: () => set((s) => ({ conversionVersion: s.conversionVersion + 1 })),
    setCursor: (cursor) => set({ cursor }),
    setEditing: (editing) => set({ editing }),
    applyEditKey: (key) =>
      set((s) => {
        if (s.editing === null) {
          return {};
        }
        const next = applyEditKeyPure(s.editing, key);
        return { editing: { ...s.editing, ...next } };
      }),
  }));
}
