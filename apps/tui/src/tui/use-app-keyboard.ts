import { useKeyboard } from "@opentui/react";
import type { KeyLike } from "@zakki/core/input/controller.ts";
import { applyCursorKey, applyKey, screenLens } from "@zakki/core/input/controller.ts";
import { matchesAction } from "@zakki/core/input/keymap.ts";
import type { EditorStore, Editing } from "@zakki/core/input/store.ts";
import { splitDisplay } from "@zakki/core/entry/records.ts";
import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import type { StoreApi } from "zustand";
import type { AmbientItem } from "./ambient.ts";

interface FrozenBlock {
  start: number;
  end: number;
  content: string;
}

/**
 * グローバルカーソルのキー配線（issue #57 で App.tsx から切り出し）。
 * 優先順位はモーダル → 編集中 → 検索 → カーソル intent → 追記入力（applyKey）。
 * キーの解釈は core の純粋関数群に委ね、ここは各アクションへの分配だけを担う。
 */
export function useAppKeyboard(options: {
  store: StoreApi<EditorStore>;
  editing: Editing | null;
  ambient: AmbientItem[];
  contextChunks: ChunkWithDate[];
  expandedChunkId: number | null;
  /** モーダル（メニュー / 確認）表示中のキー処理。true なら消費済み（dialog.tsx） */
  handleModalKey: (key: KeyLike) => boolean;
  /** 検索モード中のキー処理。true なら消費済み（use-search.ts） */
  handleSearchKey: (key: KeyLike) => boolean;
  commitEdit: () => void;
  exit: () => void;
  openEdit: (block: FrozenBlock, viewIndex: number) => void;
  openDetailEdit: (chunk: ChunkWithDate, viewIndex: number) => void;
  requestDeleteBlock: (block: FrozenBlock) => void;
  requestDeleteDetail: (chunk: ChunkWithDate) => void;
  openMenu: (items: { label: string; onChoose: () => void }[]) => void;
  openExpand: (chunkId: number) => void;
  closeExpand: () => void;
  rotateLastSegment: () => void;
  openSearch: () => void;
  /** raw の編集（保存対象の変化）を dirty 表示へ反映する */
  markDirty: () => void;
}) {
  const {
    store,
    editing,
    ambient,
    contextChunks,
    expandedChunkId,
    handleModalKey,
    handleSearchKey,
    commitEdit,
    exit,
    openEdit,
    openDetailEdit,
    requestDeleteBlock,
    requestDeleteDetail,
    openMenu,
    openExpand,
    closeExpand,
    rotateLastSegment,
    openSearch,
    markDirty,
  } = options;
  // zustand の action は store 生成時に固定された安定参照
  const { setRaw, setEditing, setCursor: moveCursor } = store.getState();

  useKeyboard((keyEvent) => {
    // モーダル（メニュー / 確認ダイアログ）表示中は他の全キー処理に優先する（docs/PANES.md §6）
    if (handleModalKey(keyEvent)) {
      return;
    }
    if (editing !== null) {
      if (matchesAction(keyEvent, "cancel")) {
        // 取消 → その View（select）へ戻る（main / detail どちらの編集でも現ペインを保つ）
        setEditing(null);
        moveCursor({
          pane: store.getState().cursor.pane,
          index: store.getState().cursor.index,
          mode: "select",
        });
        return;
      }
      if (matchesAction(keyEvent, "submit")) {
        commitEdit();
        return;
      }
      if (keyEvent.ctrl && (keyEvent.name === "c" || keyEvent.name === "d")) {
        exit();
        return;
      }
      store.getState().applyEditKey(keyEvent);
      return;
    }
    if (handleSearchKey(keyEvent)) {
      return;
    }
    // ── 単一カーソル（メイン / 関連 / 詳細 を配線） ──
    // この tick の確定チャンク数からレンズを作る。related=関連件数、detail=詳細表示件数。
    const frozenNow = splitDisplay(store.getState().raw).frozen;
    const lens = screenLens(frozenNow.length, ambient.length, contextChunks.length);
    const cur = store.getState().cursor;

    // select 上（View を指す）: カーソル系の intent で処理する
    if (cur.mode === "select") {
      const intent = applyCursorKey(cur, keyEvent, lens);
      switch (intent.type) {
        case "move":
          moveCursor(intent.cursor);
          return;
        case "edit-view": {
          // View の打ち直し編集を開く（cursor は input 維持）。main / detail で経路が異なる。
          if (intent.pane === "main") {
            const block = frozenNow[intent.index];
            if (block !== undefined) {
              openEdit(block, intent.index);
            }
          } else if (intent.pane === "detail") {
            const chunk = contextChunks[intent.index];
            if (chunk !== undefined) {
              openDetailEdit(chunk, intent.index);
            }
          }
          return;
        }
        case "delete-view": {
          // View の delete(d/Del) → 確認ダイアログ → OK で削除（docs/PANES.md §4,§6,§7）。
          if (intent.pane === "main") {
            const block = frozenNow[intent.index];
            if (block !== undefined) {
              requestDeleteBlock(block);
            }
          } else if (intent.pane === "detail") {
            const chunk = contextChunks[intent.index];
            if (chunk !== undefined) {
              requestDeleteDetail(chunk);
            }
          }
          return;
        }
        case "menu-view": {
          // View の select(Space/Enter) → メニュー（編集 / 削除, docs/PANES.md §4,§6,§7）。
          const viewIndex = intent.index;
          if (intent.pane === "main") {
            const block = frozenNow[viewIndex];
            if (block === undefined) {
              return;
            }
            openMenu([
              { label: "編集", onChoose: () => openEdit(block, viewIndex) },
              { label: "削除", onChoose: () => requestDeleteBlock(block) },
            ]);
          } else if (intent.pane === "detail") {
            const chunk = contextChunks[viewIndex];
            if (chunk === undefined) {
              return;
            }
            openMenu([
              {
                label: "編集",
                onChoose: () => {
                  openDetailEdit(chunk, viewIndex);
                },
              },
              { label: "削除", onChoose: () => requestDeleteDetail(chunk) },
            ]);
          }
          return;
        }
        case "expand-digest": {
          // related の Digest 起動 → 詳細展開＋カーソル移送（openExpand 内で moveCursor）
          const item = ambient[intent.index];
          if (item !== undefined) {
            openExpand(item.chunkId);
          }
          return;
        }
        case "close": {
          // detail にカーソルがあれば閉じて関連へ戻す。それ以外は従来どおり閉じる。
          if (cur.pane === "detail") {
            const ai = ambient.findIndex((a) => a.chunkId === expandedChunkId);
            closeExpand();
            moveCursor({ pane: "related", index: ai < 0 ? 0 : ai, mode: "select" });
          } else {
            closeExpand();
          }
          return;
        }
        case "none":
          // select 中の印字・backspace 等は無視（docs/PANES.md §4）。
          // exit / 検索などのグローバル操作（Ctrl 系）だけ applyKey へ通す。
          if (!keyEvent.ctrl) {
            return;
          }
          break;
      }
    }

    // New 上（mode:input かつ index===lens.main）: まずカーソル系（↑で直上 View へ）
    if (cur.mode === "input" && cur.pane === "main" && cur.index === lens.main) {
      const intent = applyCursorKey(cur, keyEvent, lens);
      if (intent.type === "move") {
        moveCursor(intent.cursor);
        return;
      }
      // それ以外は通常の追記入力（applyKey）へ落ちる
    }

    const action = applyKey(store.getState().raw, keyEvent);
    switch (action.type) {
      case "exit":
        exit();
        return;
      case "rotate":
        rotateLastSegment();
        return;
      case "open-search":
        openSearch();
        return;
      case "edit":
        setRaw(action.raw);
        markDirty();
        return;
      case "none":
        return;
    }
  });
}
