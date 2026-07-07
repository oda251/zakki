import { useCallback } from "react";
import type { EditorStore } from "@zakki/core/input/store.ts";
import { editableBlockAt, replaceBlock } from "@zakki/core/entry/records.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import { deleteChunk, updateChunkContent } from "@zakki/data/chunk/repository.ts";
import type { Result } from "neverthrow";
import type { StoreApi } from "zustand";
import type { ExportError, ExportSummary } from "@zakki/tui/export/obsidian.ts";
import type { AmbientItem } from "./ambient.ts";
import { planEditCommit, type EditPlan } from "./edit-plan.ts";

/** チャンク削除の確認ダイアログ文言（d 直行・メニュー経由・詳細で共通） */
const DELETE_CONFIRM_MESSAGE = "このチャンクを削除しますか？";

/**
 * 確定チャンクの編集・削除アクション群（issue #57 で App.tsx から切り出し）。
 * 分類は planEditCommit（純関数）に委ね、ここは plan の interpret とカーソル移動・
 * ダイアログ・詳細再取得の配線だけを担う（docs/PANES.md §4, §6, §7）。
 */
export function useEditActions(options: {
  db: Db;
  /** 当日（過去チャンクとの経路分岐に使う） */
  date: string;
  dateChunkId: number;
  store: StoreApi<EditorStore>;
  exportFor: (target: string) => Promise<Result<ExportSummary, ExportError> | null>;
  /** raw の編集（保存対象の変化）を dirty 表示へ反映する */
  markDirty: () => void;
  onMessage: (message: string) => void;
  openConfirm: (message: string, onConfirm: () => void) => void;
  /** 詳細ペイン（use-detail-pane.ts）の状態と操作 */
  contextChunks: ChunkWithDate[];
  expandedChunkId: number | null;
  closeExpand: () => void;
  refreshContext: (chunkId: number) => void;
  /** 関連（アンビエント）一覧。詳細削除後のカーソル戻し先を引く */
  ambient: AmbientItem[];
}) {
  const {
    db,
    date,
    dateChunkId,
    store,
    exportFor,
    markDirty,
    onMessage,
    openConfirm,
    contextChunks,
    expandedChunkId,
    closeExpand,
    refreshContext,
    ambient,
  } = options;
  // zustand の action は store 生成時に固定された安定参照
  const { setRaw, setEditing, setCursor: moveCursor } = store.getState();

  /**
   * 確定チャンクの修正を開く（クリック）。元テキストをプレーンテキストとして読み込み、
   * カーソルを末尾に置く。修正中はかな漢字変換せず、打った文字がそのまま入る
   * （文単位の非同期変換はバッファ途中のインライン変換ができないため）。
   */
  const openEdit = useCallback(
    (block: { start: number; end: number; content: string }, viewIndex: number) => {
      setEditing({
        target: { kind: "main", start: block.start, end: block.end },
        text: block.content,
        cursor: block.content.length,
        old: block.content,
      });
      // 編集中はカーソルを当該 View（mode:"input"）に維持する
      moveCursor({ pane: "main", index: viewIndex, mode: "input" });
      closeExpand();
    },
    [closeExpand, moveCursor, setEditing],
  );

  /**
   * 詳細ペインの過去/当日チャンクの修正を開く（docs/PANES.md §7）。
   * 編集の初期値はどのケースも DB の content（確定テキスト）でよい。凍結リテラルの
   * 解決は当日の raw 反映時（commitEdit の resolveBlock）にのみ必要で、初期表示には不要。
   */
  const openDetailEdit = useCallback(
    (chunk: ChunkWithDate, viewIndex: number) => {
      setEditing({
        target: { kind: "detail", date: chunk.date, position: chunk.position, chunkId: chunk.id },
        text: chunk.content,
        cursor: chunk.content.length,
        old: chunk.content,
      });
      moveCursor({ pane: "detail", index: viewIndex, mode: "input" });
    },
    [moveCursor, setEditing],
  );

  /**
   * EditPlan の DB / raw 効果だけを適用する共有インタプリタ（docs/PANES.md §4, §7）。
   * カーソル移動・editing クリア・詳細の再取得は呼び出し側（commit / delete）が担い、
   * ここは「何を書き込むか」だけを実行する（当日直下は raw 反映、過去・深い階層は id 直操作）。
   * - rawReplace: 当日 raw のリテラル領域を置換（text="" は削除。ライブ末尾を失わない）。
   * - detailUpdate / detailDelete: chunk id で直接 DB を更新/削除し、当該日を再エクスポート。
   */
  const applyEditEffect = useCallback(
    (plan: EditPlan) => {
      switch (plan.kind) {
        case "revert":
          return;
        case "rawReplace": {
          const next = replaceBlock(store.getState().raw, plan.start, plan.end, plan.text);
          setRaw(next);
          markDirty();
          return;
        }
        case "detailUpdate":
        case "detailDelete": {
          const op =
            plan.kind === "detailDelete"
              ? deleteChunk(db, plan.chunkId)
              : updateChunkContent(db, plan.chunkId, plan.text);
          void op.match(
            async () => {
              const exported = await exportFor(plan.date);
              exported?.mapErr((e) => onMessage(`export: ${e.message}`));
            },
            (e) => onMessage(`保存: ${e.message}`),
          );
          return;
        }
      }
    },
    [db, exportFor, store, setRaw, markDirty, onMessage],
  );

  /**
   * 修正を確定: リテラル領域を打ち直したプレーンテキストで置換する（変換しない）。
   * 空確定は削除しない（元のテキストに戻す＝変更なしで閉じる, docs/PANES.md §4）。
   * 分類は planEditCommit（純関数）に委ね、shell は plan の interpret と
   * カーソル移動・詳細再取得だけを行う。削除は View への d → 確認ダイアログ経由でのみ行う。
   */
  const commitEdit = useCallback(() => {
    const current = store.getState().editing;
    if (current === null) {
      return;
    }
    const pane = store.getState().cursor.pane;
    const index = store.getState().cursor.index;
    // parentId は表示中の contextChunks から引く（見つからなければ id 直更新側へ倒れて安全）。
    const target = current.target;
    const parentId =
      target.kind === "detail"
        ? (contextChunks.find((c) => c.id === target.chunkId)?.parentId ?? -1)
        : -1;
    const plan = planEditCommit(current, {
      today: date,
      dateChunkId,
      parentId,
      resolveBlock: (position) => {
        const block = editableBlockAt(store.getState().raw, position);
        return block === null ? null : { start: block.start, end: block.end };
      },
    });
    // 空確定は編集を破棄して元に戻す（削除はしない）。その View（select）へ戻る。
    if (plan !== null && plan.kind === "revert") {
      setEditing(null);
      moveCursor({ pane, index, mode: "select" });
      return;
    }
    if (current.target.kind === "main") {
      if (plan !== null) {
        applyEditEffect(plan);
      }
      setEditing(null);
      // 確定後はそのチャンク（View, select）にカーソルを戻す。
      moveCursor({ pane, index, mode: "select" });
      return;
    }
    // ── detail: 当日直下（raw 反映）/過去・深い階層（id 直更新）/解決失敗（エラー表示）。
    setEditing(null);
    if (plan === null) {
      onMessage("対象チャンクが見つかりません");
    } else {
      applyEditEffect(plan);
    }
    // 表示中の詳細を最新へ更新し、当該 detail View(select) にカーソルを戻す
    refreshContext(current.target.chunkId);
    moveCursor({ pane, index, mode: "select" });
  }, [
    moveCursor,
    applyEditEffect,
    store,
    setEditing,
    contextChunks,
    date,
    dateChunkId,
    onMessage,
    refreshContext,
  ]);

  /**
   * 確定チャンクの実削除（リテラル領域を空に置換, docs/PANES.md §4）。
   * d 直行・メニュー経由の両方が同じこの経路を通る（重複を避ける）。
   */
  const deleteBlock = useCallback(
    (block: { start: number; end: number }) => {
      applyEditEffect({ kind: "rawReplace", start: block.start, end: block.end, text: "" });
      // 削除で要素が消えるので clampInputCursor（レンダー時）が直上 / New へ補正する
      moveCursor({ pane: "main", index: store.getState().cursor.index, mode: "select" });
    },
    [applyEditEffect, moveCursor, store],
  );

  /** 削除の確認ダイアログを開く（OK で deleteBlock を呼ぶ）。d 直行・メニュー共通。 */
  const requestDeleteBlock = useCallback(
    (block: { start: number; end: number }) => {
      openConfirm(DELETE_CONFIRM_MESSAGE, () => deleteBlock(block));
    },
    [deleteBlock, openConfirm],
  );

  /**
   * 詳細ペインの過去/当日チャンクの実削除（docs/PANES.md §7）。
   * 当日直下は store の raw から領域を消し（rawReplace, text=""）、過去・深い階層は
   * chunk id で直接削除する（detailDelete）。削除で要素が消えるため closeExpand し
   * カーソルを関連へ戻す。
   */
  const deleteDetailChunk = useCallback(
    (chunk: ChunkWithDate) => {
      if (chunk.date === date && chunk.parentId === dateChunkId) {
        const block = editableBlockAt(store.getState().raw, chunk.position);
        if (block === null) {
          onMessage("対象チャンクが見つかりません");
        } else {
          applyEditEffect({ kind: "rawReplace", start: block.start, end: block.end, text: "" });
        }
      } else {
        applyEditEffect({ kind: "detailDelete", chunkId: chunk.id, date: chunk.date });
      }
      // 詳細を閉じてカーソルを関連へ戻す（展開元の ambient index、無ければ 0）
      closeExpand();
      const ai = ambient.findIndex((a) => a.chunkId === expandedChunkId);
      moveCursor({ pane: "related", index: ai < 0 ? 0 : ai, mode: "select" });
    },
    [
      applyEditEffect,
      date,
      dateChunkId,
      store,
      closeExpand,
      ambient,
      expandedChunkId,
      moveCursor,
      onMessage,
    ],
  );

  /** 詳細削除の確認ダイアログを開く（OK で deleteDetailChunk）。d 直行・メニュー共通。 */
  const requestDeleteDetail = useCallback(
    (chunk: ChunkWithDate) => {
      openConfirm(DELETE_CONFIRM_MESSAGE, () => deleteDetailChunk(chunk));
    },
    [deleteDetailChunk, openConfirm],
  );

  return {
    openEdit,
    openDetailEdit,
    commitEdit,
    requestDeleteBlock,
    requestDeleteDetail,
  };
}
