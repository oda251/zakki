import { decodePasteBytes } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { runAnalysisPass } from "@zakki/backend/analysis/pass.ts";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { fmtPolarity, moodColor, scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import { saveConversion } from "@zakki/data/conversion/cache.ts";
import { saveCorrection } from "@zakki/data/conversion/corrections.ts";
import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import { createConversionSession } from "@zakki/core/conversion/compose.ts";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { nearestChunks } from "@zakki/data/embedding/semantic.ts";
import { persistEntry } from "@zakki/data/entry/autosave.ts";
import type { ChunkWithDate } from "@zakki/data/entry/queries.ts";
import { getChunkContext, listChunksWithDate } from "@zakki/data/entry/queries.ts";
import {
  editableBlockAt,
  freezeLiveTail,
  parseBlocks,
  replaceBlock,
} from "@zakki/core/entry/records.ts";
import type { Result } from "neverthrow";
import { getEntryWithChunks } from "@zakki/data/entry/repository.ts";
import { getEntryExportChunks } from "@zakki/tui/export/data.ts";
import type { ExportError, ExportSummary } from "@zakki/tui/export/obsidian.ts";
import { exportEntry } from "@zakki/tui/export/obsidian.ts";
import { convertRomaji } from "@zakki/core/romaji/convert.ts";
import type { SearchIndex } from "@zakki/tui/search/index.ts";
import { buildIndex, searchChunks } from "@zakki/tui/search/index.ts";
import { searchSemantic } from "@zakki/tui/search/semantic.ts";
import type { Cursor, ScreenLens } from "@zakki/core/input/controller.ts";
import {
  applyCursorKey,
  applyDialogKey,
  applyKey,
  applyMenuKey,
  applySearchKey,
  clampCursor,
} from "@zakki/core/input/controller.ts";
import { useStore } from "zustand";
import { createEditorStore } from "@zakki/core/input/store.ts";
import { Chunk } from "./chunk.tsx";
import { Dialog } from "./dialog.tsx";
import { matchesAction } from "@zakki/core/input/keymap.ts";
import { useBarCursor, type BarCursorTarget } from "./native-cursor.ts";

/** キーストローク単位の永続化（docs/CONCEPT.md）。打鍵停止後この時間で保存する */
const SAVE_DEBOUNCE_MS = 300;
/** 解析（タグ・関連・埋め込み）と vault への反映は保存より粗くてよい */
const ANALYZE_EXPORT_DEBOUNCE_MS = 2000;
const SEARCH_RESULT_LIMIT = 8;
/** 全文ヒットと重複しない「意味が近い」補足の最大件数 */
const MAX_SEMANTIC_EXTRA = 4;
const AMBIENT_LIMIT = 5;
/** 関連（アンビエント）パネルの幅 */
const AMBIENT_PANEL_WIDTH = 30;
/** 関連を展開したとき、当該チャンクの前後に何件ずつ並べるか */
const CONTEXT_RADIUS = 1;
/** チャンク削除の確認ダイアログ文言（d 直行・メニュー経由・詳細で共通） */
const DELETE_CONFIRM_MESSAGE = "このチャンクを削除しますか？";

export interface AppProps {
  db: Db;
  date: string;
  /** 起動時に解決済みの当日デフォルトセッション。保存のたびの再解決を省く */
  sessionId: number;
  initialRaw: string;
  vaultDir: string;
  engine: KanaKanjiEngine;
  /** 学習済みの手動修正（かな → 確定表記）。起動時に corrections テーブルから読む */
  corrections: ReadonlyMap<string, string>;
  /** 永続化済みの自動変換キャッシュ。起動時の全文再変換を避けるためシードする */
  conversionCache: ReadonlyMap<string, string>;
  /** ローカル embedding。null なら関連・セマンティック機能は無効（決定的動作のみ） */
  embedder: Embedder | null;
  /** リモートとの同期（ベストエフォート）。ローカル専用なら no-op の Ok を返す */
  sync: () => Promise<Result<void, DbError>>;
}

type SaveState = "saved" | "dirty" | "error";

interface AmbientItem {
  chunkId: number;
  date: string;
  /** タイトルは描画時に makeTitle で導出する（派生値は保持しない） */
  content: string;
}

/**
 * 子要素を scrollbox の上端へ合わせる（docs/PANES.md §5 の表示窓制御）。
 * scrollChildIntoView と同じ child.y / viewport.y を使い、差分だけスクロールする
 * （子は折り返しで高さ可変なため、index からの概算ではなく実レイアウトで合わせる）。
 */
function anchorChildToTop(sb: ScrollBoxRenderable, childId: string): void {
  const child = sb.content.findDescendantById(childId);
  if (child !== undefined) {
    sb.scrollBy({ x: 0, y: child.y - sb.viewport.y });
  }
}

export function App({
  db,
  date,
  sessionId,
  initialRaw,
  vaultDir,
  engine,
  corrections,
  conversionCache,
  embedder,
  sync,
}: AppProps) {
  const [store] = useState(() =>
    createEditorStore({
      raw: initialRaw,
      cursor: {
        pane: "main",
        index: parseBlocks(initialRaw).filter((b) => b.frozen).length,
        mode: "input",
      },
    }),
  );
  const raw = useStore(store, (s) => s.raw);
  // 変換解決のたびに増え、再描画と再保存（effect の依存）を駆動する
  const conversionVersion = useStore(store, (s) => s.conversionVersion);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chunkCount, setChunkCount] = useState(0);
  const [message, setMessage] = useState("");
  // 単一グローバルカーソル（docs/PANES.md §3）。既定はメインの New（末尾入力）。
  // 初期 index は起動時の確定チャンク数（＝New の位置）。
  const cursor = useStore(store, (s) => s.cursor);
  // 確定チャンクの修正（クリックで開く）。null なら通常入力
  const editing = useStore(store, (s) => s.editing);
  // 確認ダイアログ（破壊的操作の確認, docs/PANES.md §6）。null なら非表示。
  // 最小形 { message, onConfirm } で持ち、将来の確認操作も同じ仕組みを再利用する。
  const [dialog, setDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);
  // メニューダイアログ（操作の選択, docs/PANES.md §6）。null なら非表示。
  // 各項目は { label, onChoose }。確認ダイアログと同列で、どちらか一方のみ開く。
  const [menu, setMenu] = useState<{
    items: { label: string; onChoose: () => void }[];
    index: number;
  } | null>(null);
  const [mode, setMode] = useState<"write" | "search">("write");
  const [searchQuery, setSearchQuery] = useState("");
  // 検索索引の非同期ロード完了で全文ヒットの再計算を駆動する
  const [searchIndexVersion, setSearchIndexVersion] = useState(0);
  const [semanticHits, setSemanticHits] = useState<ChunkWithDate[]>([]);
  const [ambient, setAmbient] = useState<AmbientItem[]>([]);
  // 関連項目をクリックすると、その投稿の前後を右パネルに展開する（null で一覧表示）
  const [expandedChunkId, setExpandedChunkId] = useState<number | null>(null);
  // 展開中の「当該チャンク＋前後」。クリック時に getChunkContext で取得して保持する
  const [contextChunks, setContextChunks] = useState<ChunkWithDate[]>([]);
  const searchIndexRef = useRef<SearchIndex | null>(null);
  const searchChunksRef = useRef<Map<number, ChunkWithDate>>(new Map());
  const renderer = useRenderer();
  const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // メインの scrollbox 実体。カーソル追従スクロール（scrollChildIntoView）に使う
  const mainScrollRef = useRef<ScrollBoxRenderable | null>(null);
  // 詳細ペインの scrollbox 実体。詳細にカーソルがあるときの追従スクロールに使う
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // zustand の action は store 生成時に固定された安定参照。useCallback で包む必要はない。
  // setCursor は「取りこぼし防止＋表示更新」の意味で moveCursor と呼ぶ。
  const { setRaw, setEditing, bumpConversion: bump, setCursor: moveCursor } = store.getState();

  // 変換合成（機能ロジック）は core と共有し、副作用（永続化・エラー表示）だけ注入する
  const conversion = useMemo(
    () =>
      createConversionSession(engine, {
        corrections,
        cache: conversionCache,
        onUpdate: bump,
        onError: (m) => setMessage(`変換エラー: ${m}`),
        // 確定した変換を永続化し、次回起動時にシードして全文再変換を避ける
        onConverted: (kana, conv) => {
          void saveConversion(db, kana, conv).mapErr((e) => setMessage(`変換保存: ${e.message}`));
        },
        onChosen: (kana, chosen) => {
          void saveCorrection(db, kana, chosen).match(
            () => {},
            (e) => setMessage(`学習エラー: ${e.message}`),
          );
        },
      }),
    [engine, corrections, conversionCache, db, bump],
  );
  const { convertRaw, convertSettled } = conversion;
  // Tab: 直前の変換単位の候補ローテーション。選択は corrections に学習する
  const rotateLastSegment = useCallback(
    () => conversion.rotateLastSegment(store.getState().raw),
    [conversion, store],
  );

  // タグ・関連の鮮度は前回解析時点でよい（次回の解析で追いつく）。
  // 任意の日付を再エクスポートする（過去チャンク編集後の反映に使う）。
  const exportFor = useCallback(
    async (target: string): Promise<Result<ExportSummary, ExportError> | null> => {
      const chunks = await getEntryExportChunks(db, target);
      if (chunks.isErr()) {
        setMessage(`export: ${chunks.error.message}`);
        return null;
      }
      return exportEntry({ vaultDir, date: target, chunks: chunks.value });
    },
    [db, vaultDir],
  );
  const exportCurrent = useCallback(() => exportFor(date), [exportFor, date]);

  /** アンビエント表示: 直近チャンクの関連を更新する（docs/FEATURES.md 候補1） */
  const refreshAmbient = useCallback(
    (vectors: ReadonlyMap<number, Float32Array>) => {
      void listChunksWithDate(db).match(
        (all) => {
          const todays = all.filter((c) => c.date === date);
          const last = todays.at(-1);
          const lastVector = last === undefined ? undefined : vectors.get(last.id);
          if (last === undefined || lastVector === undefined) {
            return;
          }
          const byId = new Map(all.map((c) => [c.id, c]));
          const items = nearestChunks(vectors, lastVector, AMBIENT_LIMIT + 1)
            .filter((n) => n.chunkId !== last.id)
            .slice(0, AMBIENT_LIMIT)
            .flatMap((n) => {
              const chunk = byId.get(n.chunkId);
              return chunk === undefined
                ? []
                : [{ chunkId: chunk.id, date: chunk.date, content: chunk.content }];
            });
          setAmbient(items);
        },
        () => {},
      );
    },
    [db, date],
  );

  /** 保存より粗い周期で走るバックグラウンド処理: 解析 → 埋め込み → エクスポート */
  const runBackgroundPass = useCallback(() => {
    void runAnalysisPass(db, embedder, setMessage)
      .then((vectors) => {
        if (vectors !== null) {
          refreshAmbient(vectors);
        }
      })
      .finally(() => {
        void exportCurrent().then((result) => {
          result?.mapErr((e) => setMessage(`export: ${e.message}`));
        });
      });
  }, [db, embedder, exportCurrent, refreshAmbient]);

  const exit = useCallback(() => {
    // flush 保存（打鍵途中の n を確定）→ エクスポート → 端末復帰。
    // raw が正本なので未確定セグメントの変換完了は待たない（次回起動で回収）。
    const snapshot = {
      date,
      sessionId,
      raw: store.getState().raw,
      converted: convertRaw(store.getState().raw, true).text,
    };
    const finish = () => {
      engine.close();
      renderer.destroy();
      process.exit(0);
    };
    void persistEntry(db, snapshot).match(async () => {
      // export の成否に関わらず端末を復帰する（保存は完了済み）
      await exportCurrent();
      // ローカル保存は完了済み。リモート同期はベストエフォートで、失敗しても終了を妨げない
      // （オフライン・未設定は正常系。ローカル専用なら no-op）。
      await sync();
      finish();
    }, finish);
  }, [db, date, sessionId, renderer, engine, convertRaw, exportCurrent, sync, store]);

  /** 関連の詳細を閉じる（一覧表示へ戻す） */
  const closeExpand = useCallback(() => {
    setExpandedChunkId(null);
    setContextChunks([]);
  }, []);

  /**
   * 関連項目クリック / Digest 起動: その投稿＋前後を取得して詳細ペインに展開し、
   * カーソルを詳細ペインの当該チャンクへ移送する（docs/PANES.md §5 4a, §7 初期位置）。
   */
  const openExpand = useCallback(
    (chunkId: number) => {
      void getChunkContext(db, chunkId, CONTEXT_RADIUS).match(
        (ctx) => {
          setExpandedChunkId(chunkId);
          setContextChunks(ctx);
          // 詳細内の当該チャンク index にカーソルを移す（無ければ 0）
          const idx = ctx.findIndex((c) => c.id === chunkId);
          moveCursor({ pane: "detail", index: idx < 0 ? 0 : idx, mode: "select" });
        },
        (e) => setMessage(`関連: ${e.message}`),
      );
    },
    [db, moveCursor],
  );

  /**
   * 確定チャンクの修正を開く（クリック）。元テキストをプレーンテキストとして読み込み、
   * カーソルを末尾に置く。修正中はかな漢字変換せず、打った文字がそのまま入る
   * （文単位の非同期変換はバッファ途中のインライン変換ができないため）。
   */
  const openEdit = useCallback(
    (block: { start: number; end: number; text: string }, viewIndex: number) => {
      setEditing({
        target: { kind: "main", start: block.start, end: block.end },
        text: block.text,
        cursor: block.text.length,
        old: block.text,
      });
      // 編集中はカーソルを当該 View（mode:"input"）に維持する
      moveCursor({ pane: "main", index: viewIndex, mode: "input" });
      closeExpand();
    },
    [closeExpand, moveCursor],
  );

  /**
   * 詳細ペインの過去/当日チャンクの修正を開く（docs/PANES.md §7）。
   * 対象 raw（当日=store の raw / 過去=DB）から editableBlockAt で領域を解決する。
   * 末尾ライブ文は凍結リテラルが無いため、編集の初期値には DB の content を使う
   * （確定時にその文だけが literal へ畳まれる, patchDetailChunk）。
   */
  const openDetailEdit = useCallback(
    async (chunk: ChunkWithDate, viewIndex: number) => {
      const targetRaw =
        chunk.date === date
          ? store.getState().raw
          : await getEntryWithChunks(db, chunk.date).match(
              (e) => e?.entry.raw ?? "",
              (e) => {
                setMessage(`読込: ${e.message}`);
                return "";
              },
            );
      const block = editableBlockAt(targetRaw, chunk.position);
      if (block === null) {
        setMessage("対象チャンクが見つかりません");
        return;
      }
      // 凍結リテラルは本文を、ライブ末尾文は表示中の確定テキスト（DB content）を初期値にする
      const initial = block.frozen ? block.text : chunk.content;
      setEditing({
        target: { kind: "detail", date: chunk.date, position: chunk.position, chunkId: chunk.id },
        text: initial,
        cursor: initial.length,
        old: initial,
      });
      moveCursor({ pane: "detail", index: viewIndex, mode: "input" });
    },
    [db, date, moveCursor, store, setEditing],
  );

  /**
   * 詳細ペイン経由の確定チャンク編集/削除を、対象エントリの raw に反映する（docs/PANES.md §7）。
   * `nextText` が空文字なら削除（replaceBlock が領域を消す）。当日は store の raw を正本とし
   * （ライブ末尾を失わない）、過去は DB から raw を再取得して即保存＋当該日を再エクスポートする。
   * stale offset を避けるため、領域は呼び出し時点の raw から `editableBlockAt` で再解決する。
   */
  const patchDetailChunk = useCallback(
    async (chunk: { date: string; position: number }, nextText: string) => {
      if (chunk.date === date) {
        const block = editableBlockAt(store.getState().raw, chunk.position);
        if (block === null) {
          setMessage("対象チャンクが見つかりません");
          return;
        }
        const next = replaceBlock(store.getState().raw, block.start, block.end, nextText);
        setRaw(next);
        setSaveState("dirty");
        return;
      }
      await getEntryWithChunks(db, chunk.date).match(
        async (entry) => {
          const targetRaw = entry?.entry.raw ?? "";
          const block = editableBlockAt(targetRaw, chunk.position);
          if (block === null) {
            setMessage("対象チャンクが見つかりません");
            return;
          }
          const next = replaceBlock(targetRaw, block.start, block.end, nextText);
          await persistEntry(db, {
            date: chunk.date,
            raw: next,
            converted: convertRaw(next).text,
          }).match(
            async () => {
              const exported = await exportFor(chunk.date);
              exported?.mapErr((e) => setMessage(`export: ${e.message}`));
            },
            (e) => setMessage(`保存: ${e.message}`),
          );
        },
        (e) => setMessage(`読込: ${e.message}`),
      );
    },
    [db, date, convertRaw, exportFor, store, setRaw],
  );

  /**
   * 修正を確定: リテラル領域を打ち直したプレーンテキストで置換する（変換しない）。
   * 空確定は削除しない（元のテキストに戻す＝変更なしで閉じる, docs/PANES.md §4）。
   * 削除は View への d → 確認ダイアログ経由でのみ行う。
   */
  const commitEdit = useCallback(() => {
    const current = store.getState().editing;
    if (current === null) {
      return;
    }
    const text = current.text.trim();
    const pane = store.getState().cursor.pane;
    const index = store.getState().cursor.index;
    // 空確定は編集を破棄して元に戻す（削除はしない）。その View（select）へ戻る。
    if (text === "") {
      setEditing(null);
      moveCursor({ pane, index, mode: "select" });
      return;
    }
    if (current.target.kind === "main") {
      const next = replaceBlock(
        store.getState().raw,
        current.target.start,
        current.target.end,
        text,
      );
      setRaw(next);
      setSaveState("dirty");
      setEditing(null);
      // 確定後はそのチャンク（View, select）にカーソルを戻す。
      moveCursor({ pane, index, mode: "select" });
      return;
    }
    // ── detail: 対象エントリの raw に反映（patchDetailChunk が当日/過去を分岐）──
    const { date: targetDate, position, chunkId } = current.target;
    setEditing(null);
    void patchDetailChunk({ date: targetDate, position }, text);
    // 表示中の詳細を最新へ更新し、当該 detail View(select) にカーソルを戻す
    void getChunkContext(db, chunkId, CONTEXT_RADIUS).match(
      (ctx) => setContextChunks(ctx),
      () => {},
    );
    moveCursor({ pane, index, mode: "select" });
  }, [moveCursor, db, patchDetailChunk, store, setRaw, setEditing]);

  /**
   * 確定チャンクの実削除（リテラル領域を空に置換, docs/PANES.md §4）。
   * d 直行・メニュー経由の両方が同じこの経路を通る（重複を避ける）。
   */
  const deleteBlock = useCallback(
    (block: { start: number; end: number }) => {
      const next = replaceBlock(store.getState().raw, block.start, block.end, "");
      setRaw(next);
      setSaveState("dirty");
      // 削除で要素が消えるので clampCursor（レンダー時）が直上 / New へ補正する
      moveCursor({ pane: "main", index: store.getState().cursor.index, mode: "select" });
    },
    [moveCursor, store, setRaw],
  );

  /** 削除の確認ダイアログを開く（OK で deleteBlock を呼ぶ）。d 直行・メニュー共通。 */
  const requestDeleteBlock = useCallback(
    (block: { start: number; end: number }) => {
      setDialog({
        message: DELETE_CONFIRM_MESSAGE,
        onConfirm: () => deleteBlock(block),
      });
    },
    [deleteBlock],
  );

  /**
   * 詳細ペインの過去/当日チャンクの実削除（docs/PANES.md §7）。
   * date+position から領域を再解決し空に置換する。当日は store の raw、過去は
   * DB 保存＋再エクスポート。削除で要素が消えるため closeExpand しカーソルを関連へ戻す。
   */
  const deleteDetailChunk = useCallback(
    (chunk: ChunkWithDate) => {
      // 空テキストで置換＝削除（patchDetailChunk が当日/過去を分岐）
      void patchDetailChunk({ date: chunk.date, position: chunk.position }, "");
      // 詳細を閉じてカーソルを関連へ戻す（展開元の ambient index、無ければ 0）
      closeExpand();
      const ai = ambient.findIndex((a) => a.chunkId === expandedChunkId);
      moveCursor({ pane: "related", index: ai < 0 ? 0 : ai, mode: "select" });
    },
    [patchDetailChunk, closeExpand, ambient, expandedChunkId, moveCursor],
  );

  /** 詳細削除の確認ダイアログを開く（OK で deleteDetailChunk）。d 直行・メニュー共通。 */
  const requestDeleteDetail = useCallback(
    (chunk: ChunkWithDate) => {
      setDialog({
        message: DELETE_CONFIRM_MESSAGE,
        onConfirm: () => deleteDetailChunk(chunk),
      });
    },
    [deleteDetailChunk],
  );

  useKeyboard((keyEvent) => {
    // メニューダイアログ表示中は他の全キー処理に優先して握りつぶす（docs/PANES.md §6）
    if (menu !== null) {
      const a = applyMenuKey(menu.index, keyEvent, menu.items.length);
      if (a.type === "move") {
        setMenu({ ...menu, index: a.index });
      } else if (a.type === "choose") {
        const item = menu.items[menu.index];
        setMenu(null);
        item?.onChoose();
      } else if (a.type === "cancel") {
        setMenu(null);
      }
      return;
    }
    // 確認ダイアログ表示中は他の全キー処理に優先して握りつぶす（docs/PANES.md §6）
    if (dialog !== null) {
      const action = applyDialogKey(keyEvent);
      if (action === "confirm") {
        dialog.onConfirm();
        setDialog(null);
      } else if (action === "cancel") {
        setDialog(null);
      }
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
    if (mode === "search") {
      const action = applySearchKey(searchQuery, keyEvent);
      switch (action.type) {
        case "close":
          setMode("write");
          setSearchQuery("");
          setSemanticHits([]);
          return;
        case "edit":
          setSearchQuery(action.query);
          return;
        case "none":
          return;
      }
    }
    // ── 単一カーソル（メイン / 関連 / 詳細 を配線） ──
    // この tick の確定チャンク数からレンズを作る。related=関連件数、detail=詳細表示件数。
    const frozenNow = parseBlocks(store.getState().raw).filter((b) => b.frozen);
    const lens: ScreenLens = {
      main: frozenNow.length,
      related: ambient.length,
      detail: contextChunks.length,
    };
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
              void openDetailEdit(chunk, intent.index);
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
            setMenu({
              index: 0,
              items: [
                { label: "編集", onChoose: () => openEdit(block, viewIndex) },
                { label: "削除", onChoose: () => requestDeleteBlock(block) },
              ],
            });
          } else if (intent.pane === "detail") {
            const chunk = contextChunks[viewIndex];
            if (chunk === undefined) {
              return;
            }
            setMenu({
              index: 0,
              items: [
                {
                  label: "編集",
                  onChoose: () => {
                    void openDetailEdit(chunk, viewIndex);
                  },
                },
                { label: "削除", onChoose: () => requestDeleteDetail(chunk) },
              ],
            });
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
        // 索引はペインを開いた時点の全チャンクから構築する（非同期ロード後に再描画する）
        void listChunksWithDate(db)
          .match(
            (chunks) => {
              searchChunksRef.current = new Map(chunks.map((c) => [c.id, c]));
              return buildIndex(chunks);
            },
            (e) => {
              setMessage(`検索: ${e.message}`);
              return null;
            },
          )
          .then((index) => {
            searchIndexRef.current = index;
            setSearchIndexVersion((v) => v + 1);
          });
        setMode("search");
        return;
      case "edit":
        setRaw(action.raw);
        setSaveState("dirty");
        return;
      case "none":
        return;
    }
  });

  // ペースト: 変換せずそのまま 1 チャンク（凍結リテラル）に固める
  usePaste((event) => {
    if (menu !== null || dialog !== null || editing !== null) {
      return;
    }
    const pasted = decodePasteBytes(event.bytes);
    if (pasted.trim() === "") {
      return;
    }
    const next = store.getState().raw + wrapPaste(pasted);
    setRaw(next);
    setSaveState("dirty");
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      // 1. 完結・変換済みの文を凍結リテラルへ畳む（末尾の入力中チャンクは残す）
      const frozen = freezeLiveTail(store.getState().raw, convertSettled);
      if (frozen.changed) {
        setRaw(frozen.raw);
      }
      const current = store.getState().raw;
      // 2. 永続化（converted から決定的チャンク化）
      const converted = convertRaw(current).text;
      void persistEntry(db, { date, sessionId, raw: current, converted }).match(
        (saved) => {
          setSaveState("saved");
          setChunkCount(saved.chunks.length);
          if (backgroundTimer.current !== null) {
            clearTimeout(backgroundTimer.current);
          }
          backgroundTimer.current = setTimeout(runBackgroundPass, ANALYZE_EXPORT_DEBOUNCE_MS);
        },
        (e) => {
          setSaveState("error");
          setMessage(e.message);
        },
      );
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // conversionVersion: 非同期変換が確定したら再保存・再凍結する
  }, [db, date, sessionId, raw, conversionVersion, convertRaw, convertSettled, runBackgroundPass]);

  // セマンティック検索（docs/FEATURES.md 候補8）。実体は search/semantic.ts に委譲する
  useEffect(() => {
    const active = mode === "search" && embedder !== null && searchQuery !== "";
    if (!active) {
      setSemanticHits([]);
    }
    const timer = setTimeout(() => {
      if (!active || embedder === null) {
        return;
      }
      void searchSemantic(
        searchQuery,
        engine,
        embedder,
        db,
        searchChunksRef.current,
        SEARCH_RESULT_LIMIT,
      ).then(setSemanticHits);
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, searchQuery, embedder, engine, db]);

  // 表示用の分解: 先頭の確定チャンク（凍結リテラル）＋末尾のライブ入力
  const blocks = useMemo(() => parseBlocks(raw), [raw]);
  const frozen = useMemo(() => blocks.filter((b) => b.frozen), [blocks]);
  // ライブ末尾は分解済みブロックから取る（末尾ブロックが非凍結ならそれ）
  const lastBlock = blocks.at(-1);
  const liveRaw = lastBlock !== undefined && !lastBlock.frozen ? lastBlock.text : "";
  const live = useMemo(
    () => conversion.convertLive(liveRaw),
    [liveRaw, conversionVersion, conversion],
  );
  // 現在のレンズ（メイン / 関連 / 詳細）でカーソルを有効域へ補正する
  // （New 追従・チャンク削除時のフォールバック）。
  const lens = useMemo<ScreenLens>(
    () => ({ main: frozen.length, related: ambient.length, detail: contextChunks.length }),
    [frozen.length, ambient.length, contextChunks.length],
  );
  const clamped = useMemo<Cursor>(() => {
    // New（入力位置）は末尾に追従させる: 編集中でない main の input は常に末尾 New。
    // 文の確定（freeze）でチャンクが増減しても、New が後ろのチャンクに取り残されない。
    if (editing === null && cursor.pane === "main" && cursor.mode === "input") {
      return { pane: "main", index: lens.main, mode: "input" };
    }
    return clampCursor(cursor, lens);
  }, [cursor, lens, editing]);
  useEffect(() => {
    if (
      clamped.pane !== cursor.pane ||
      clamped.index !== cursor.index ||
      clamped.mode !== cursor.mode
    ) {
      store.getState().setCursor(clamped);
    }
  }, [clamped, cursor]);

  // メイン表示窓の開始 index（docs/PANES.md §5）。カーソルの 1 件手前から描画し、
  // それより古いチャンクは描画しない。clamped.index は New＝末尾・Edit＝当該・select＝当該
  // をすべて指すため、一律に「1 件手前」で計算できる。
  const windowStart = useMemo(
    () => (clamped.pane === "main" ? Math.max(0, clamped.index - 1) : 0),
    [clamped.pane, clamped.index],
  );

  // New（末尾入力）にカーソルを描くのは、グローバルカーソルが実際に New を指すときだけ。
  // 修正中（editing）や他ペイン・select 中はカーソルが別所にあるので New には出さない。
  const newFocused =
    editing === null &&
    clamped.pane === "main" &&
    clamped.mode === "input" &&
    clamped.index === lens.main;

  // 端末ネイティブ縦棒カーソルの描画対象（src/tui/native-cursor.ts）。
  // 修正中はその編集箇所、それ以外で New 入力中なら末尾（確定テキスト＋打鍵途中ローマ字の
  // 直後）。select 中・モーダル表示中・検索中は null（カーソルを隠す）。
  const barTarget = useMemo<BarCursorTarget | null>(() => {
    if (mode === "search" || dialog !== null || menu !== null) {
      return null;
    }
    if (editing !== null) {
      if (editing.target.kind === "main") {
        return {
          scope: "main",
          id: `chunk-${editing.target.start}`,
          text: editing.text,
          offset: editing.cursor,
        };
      }
      return {
        scope: "detail",
        id: `detail-${clamped.index}`,
        text: editing.text,
        offset: editing.cursor,
      };
    }
    if (newFocused) {
      const text = live.text + live.pending;
      return { scope: "main", id: "chunk-new", text, offset: text.length };
    }
    return null;
  }, [mode, dialog, menu, editing, clamped.index, newFocused, live.text, live.pending]);

  useBarCursor(renderer, barTarget, { main: mainScrollRef, detail: detailScrollRef });

  // メインは「表示窓」をそのまま上詰めで描く。scrollbox に内部スクロールが残ると
  // 先頭（1 件手前）が画面外へ隠れてしまうため、毎レンダーで先頭固定に戻す。
  useEffect(() => {
    mainScrollRef.current?.scrollTo({ x: 0, y: 0 });
  });

  // 詳細ペインだけはカーソル追従スクロールする（メインは表示窓を直接描画するため不要）。
  // 詳細はカーソルの 1 件手前を上端に寄せる（docs/PANES.md §5）。
  useEffect(() => {
    if (clamped.pane !== "detail") {
      return;
    }
    const sb = detailScrollRef.current;
    if (sb !== null) {
      anchorChildToTop(sb, `detail-${Math.max(0, clamped.index - 1)}`);
    }
  }, [clamped.index, clamped.pane]);

  const status =
    saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`;
  const convertingNote = live.converting > 0 ? ` ｜ 変換中 ${live.converting}` : "";

  // フッターの気分（当日エントリ全体のネガポジ極性）。converted の純粋な導出
  const entryMood = useMemo(() => {
    const text = convertRaw(raw).text;
    return text.trim() === "" ? null : scoreSentiment(text);
  }, [raw, conversionVersion, convertRaw]);

  const bigramHits = useMemo(() => {
    if (mode !== "search" || searchIndexRef.current === null) {
      return [];
    }
    return searchChunks(searchIndexRef.current, searchQuery).slice(0, SEARCH_RESULT_LIMIT);
  }, [mode, searchQuery, searchIndexVersion]);
  // 全文ヒットと重複しない「意味が近い」補足
  const extraSemantic = useMemo(() => {
    const seen = new Set(bigramHits.map((h) => h.id));
    return semanticHits.filter((h) => !seen.has(h.id)).slice(0, MAX_SEMANTIC_EXTRA);
  }, [bigramHits, semanticHits]);
  const queryDisplay = useMemo(() => convertRomaji(searchQuery), [searchQuery]);

  if (mode === "search") {
    return (
      <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
        <box style={{ height: 1 }}>
          <text>
            検索: {queryDisplay.converted}
            <span fg="#777777">{queryDisplay.pending}</span>
            <span fg="#aaaaaa">▌</span>
          </text>
        </box>
        <Chunk.Surface focused>
          {bigramHits.length === 0 && extraSemantic.length === 0 ? (
            <text style={{ fg: "#888888" }}>
              {searchQuery === "" ? "ローマ字で入力すると絞り込まれます" : "該当なし"}
            </text>
          ) : (
            <Fragment>
              {bigramHits.map((hit) => (
                <box key={hit.id} style={{ flexDirection: "column", marginBottom: 1 }}>
                  <text style={{ fg: "#88aaff" }}>{hit.date}</text>
                  <text style={{ fg: "#aaaaaa", wrapMode: "word" }}>{hit.content}</text>
                </box>
              ))}
              {extraSemantic.length > 0 && (
                <Fragment>
                  <text key="sem-head" style={{ fg: "#666666" }}>
                    ── 意味が近いもの ──
                  </text>
                  {extraSemantic.map((hit) => (
                    <box key={`sem-${hit.id}`} style={{ flexDirection: "column", marginBottom: 1 }}>
                      <text>
                        <span fg="#88aaff">{hit.date}</span> {makeTitle(hit.content)}
                      </text>
                    </box>
                  ))}
                </Fragment>
              )}
            </Fragment>
          )}
        </Chunk.Surface>
        <box style={{ height: 1 }}>
          <text style={{ fg: "#888888" }}>Esc で戻る</text>
        </box>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        {/* 表示窓（docs/PANES.md §5）: カーソルの 1 件手前から描画し、それより古い
            チャンクは描画しない（収まる物まで全部出さない）。上詰めで、より新しい側は
            入る限り下へ並ぶ。カーソル（＝窓の 2 番目）は常に見える。 */}
        <Chunk.Surface focused scrollRef={mainScrollRef}>
          {frozen.slice(windowStart).map((b, j) => {
            const idx = windowStart + j;
            const isEditing =
              editing !== null &&
              editing.target.kind === "main" &&
              editing.target.start === b.start;
            const selected = clamped.pane === "main" && clamped.index === idx;
            // key / id はブロック固有（raw オフセット）で安定させる。位置や確定数から
            // 導くと id が要素間で使い回され、scrollbox の子が増えない不具合になる。
            return isEditing ? (
              <box key={`chunk-${b.start}`} id={`chunk-${b.start}`}>
                <Chunk.Edit text={editing.text} />
              </box>
            ) : (
              <Chunk.View
                key={`chunk-${b.start}`}
                id={`chunk-${b.start}`}
                text={b.text}
                selected={selected}
                onClick={() => openEdit(b, idx)}
              />
            );
          })}
          {/* 入力中チャンク（ライブ）。id/key は固定（確定数で変えない）。 */}
          <Chunk.New
            key="chunk-new"
            id="chunk-new"
            text={live.text}
            pending={live.pending}
            onClick={() => moveCursor({ pane: "main", index: frozen.length, mode: "input" })}
          />
        </Chunk.Surface>
        {ambient.length > 0 && (
          <box
            style={{
              width: AMBIENT_PANEL_WIDTH,
              flexDirection: "column",
              paddingLeft: 1,
              minHeight: 0,
            }}
          >
            {/* 関連（一覧）: クリックで下の詳細ペインに前後を展開。一覧全体は縮ませない */}
            <box style={{ flexShrink: 0, flexDirection: "column" }}>
              <text style={{ fg: "#666666" }}>── 関連 ──</text>
              {ambient.map((item, idx) => (
                <Chunk.Digest
                  key={item.chunkId}
                  date={item.date}
                  content={item.content}
                  selected={
                    (clamped.pane === "related" && clamped.index === idx) ||
                    item.chunkId === expandedChunkId
                  }
                  onClick={() => openExpand(item.chunkId)}
                />
              ))}
            </box>
            {expandedChunkId !== null && (
              <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0, marginTop: 1 }}>
                <box style={{ flexShrink: 0 }} onMouseDown={closeExpand}>
                  <text style={{ fg: "#666666" }}>── 詳細（Esc で閉じる） ──</text>
                </box>
                {/* 詳細は Chunk.View のリスト（カーソル選択・インライン編集・追従スクロール）。
                    編集中の当該チャンクだけ Chunk.Edit に差し替える（docs/PANES.md §3）。 */}
                <Chunk.Surface scrollRef={detailScrollRef}>
                  {contextChunks.map((c, idx) => {
                    const isEditing =
                      editing !== null &&
                      editing.target.kind === "detail" &&
                      editing.target.chunkId === c.id;
                    const selected = clamped.pane === "detail" && clamped.index === idx;
                    return isEditing ? (
                      <box key={c.id} id={`detail-${idx}`}>
                        <Chunk.Edit text={editing.text} />
                      </box>
                    ) : (
                      <Chunk.View
                        key={c.id}
                        id={`detail-${idx}`}
                        text={c.content}
                        selected={selected}
                        onClick={() => moveCursor({ pane: "detail", index: idx, mode: "select" })}
                      />
                    );
                  })}
                </Chunk.Surface>
              </box>
            )}
          </box>
        )}
      </box>
      {editing !== null && <Chunk.Status>←→ で移動 ｜ Enter で確定 ｜ Esc で取消</Chunk.Status>}
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text style={{ fg: "#888888" }}>
          {date} ｜ チャンク {chunkCount} ｜{" "}
          {entryMood !== null && (
            <Fragment>
              <span fg={moodColor(entryMood)}>●</span>
              {`${fmtPolarity(entryMood)} ｜ `}
            </Fragment>
          )}
          {engine.name}
          {convertingNote}
        </text>
        <text style={{ fg: "#888888" }}>{status}</text>
      </box>
      {/* モーダルはオーバーレイ（position:absolute + zIndex）で通常画面に重ねる。
          確認ダイアログとメニューは同列で、どちらか一方のみ開く（docs/PANES.md §6）。 */}
      {dialog !== null && <Dialog.Confirm message={dialog.message} />}
      {menu !== null && <Dialog.Menu items={menu.items} index={menu.index} />}
    </box>
  );
}
