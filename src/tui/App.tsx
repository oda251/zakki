import { decodePasteBytes } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { analyzeAll } from "@/analysis/service.ts";
import { makeTitle } from "@/chunk/chunker.ts";
import { fmtPolarity, moodColor, scoreSentiment } from "@/analysis/sentiment.ts";
import { saveConversion } from "@/conversion/cache.ts";
import { saveCorrection } from "@/conversion/corrections.ts";
import type { KanaKanjiEngine } from "@/conversion/engine.ts";
import { stripPasteMarkers, wrapPaste } from "@/conversion/paste.ts";
import { ConversionPipeline } from "@/conversion/pipeline.ts";
import { segmentKana } from "@/conversion/segment.ts";
import type { Db } from "@/db/client.ts";
import type { Embedder } from "@/embedding/embedder.ts";
import { addSemanticLinks, nearestChunks } from "@/embedding/semantic.ts";
import { loadVectors, syncChunkEmbeddings } from "@/embedding/store.ts";
import { persistEntry } from "@/entry/autosave.ts";
import type { ChunkWithDate } from "@/entry/queries.ts";
import { getChunkContext, listChunksWithDate } from "@/entry/queries.ts";
import { freezeLiveTail, frozenBlockAt, parseBlocks, replaceBlock } from "@/entry/records.ts";
import { getEntryWithChunks } from "@/entry/repository.ts";
import { getEntryExportChunks } from "@/export/data.ts";
import { exportEntry } from "@/export/obsidian.ts";
import { convertRomaji } from "@/romaji/convert.ts";
import type { SearchIndex } from "@/search/index.ts";
import { buildIndex, searchChunks } from "@/search/index.ts";
import { searchSemantic } from "@/search/semantic.ts";
import type { Cursor, CursorState, ScreenLens } from "./controller.ts";
import {
  applyCursorKey,
  applyDialogKey,
  applyEditKey,
  applyKey,
  applyMenuKey,
  applySearchKey,
  clampCursor,
} from "./controller.ts";
import { Chunk } from "./chunk.tsx";
import { Dialog } from "./dialog.tsx";
import { matchesAction } from "./keymap.ts";

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
  initialRaw: string;
  vaultDir: string;
  engine: KanaKanjiEngine;
  /** 学習済みの手動修正（かな → 確定表記）。起動時に corrections テーブルから読む */
  corrections: ReadonlyMap<string, string>;
  /** 永続化済みの自動変換キャッシュ。起動時の全文再変換を避けるためシードする */
  conversionCache: ReadonlyMap<string, string>;
  /** ローカル embedding。null なら関連・セマンティック機能は無効（決定的動作のみ） */
  embedder: Embedder | null;
}

type SaveState = "saved" | "dirty" | "error";

/**
 * 修正対象の指定（docs/PANES.md §7）。
 * - main: 当日 bufferRef 内のリテラル領域 [start, end)（メインペインの確定チャンク）。
 * - detail: 詳細ペインの過去/当日チャンク。commit 時に date+position から領域を再解決する
 *   （stale offset を避ける）。当日（date===props date）も bufferRef を正本とする。
 */
type EditTarget =
  | { kind: "main"; start: number; end: number }
  | { kind: "detail"; date: string; position: number; chunkId: number };

/**
 * 修正中の確定チャンク（記録モデル, docs/RECORDS.md）。
 * raw 内のリテラル領域を、プレーンテキスト＋可動カーソルで打ち直す（再変換しない）。
 */
interface Editing {
  /** 編集対象（メイン or 詳細） */
  target: EditTarget;
  /** 編集中のプレーンテキスト（空のまま確定すると元に戻す＝削除しない） */
  text: string;
  /** カーソル位置 [0, text.length] */
  cursor: number;
  /** 参照表示する元の確定テキスト */
  old: string;
}

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
  initialRaw,
  vaultDir,
  engine,
  corrections,
  conversionCache,
  embedder,
}: AppProps) {
  const [raw, setRaw] = useState(initialRaw);
  // 変換解決のたびに増え、再描画と再保存（effect の依存）を駆動する
  const [conversionVersion, setConversionVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chunkCount, setChunkCount] = useState(0);
  const [message, setMessage] = useState("");
  // 単一グローバルカーソル（docs/PANES.md §3）。既定はメインの New（末尾入力）。
  // 初期 index は起動時の確定チャンク数（＝New の位置）。
  const [cursor, setCursor] = useState<Cursor>(() => ({
    pane: "main",
    index: parseBlocks(initialRaw).filter((b) => b.frozen).length,
    mode: "input",
  }));
  // 確定チャンクの修正（クリックで開く）。null なら通常入力
  const [editing, setEditing] = useState<Editing | null>(null);
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
  // 入力の正本。キーイベントは同一 tick に連続して届くため、render を待つ
  // state ではなく ref を同期更新して取りこぼしを防ぐ（state は表示用）。
  const bufferRef = useRef(initialRaw);
  // 修正バッファ（プレーンテキスト＋カーソル）も ref で同期更新し取りこぼしを防ぐ
  const editRef = useRef<CursorState>({ text: "", cursor: 0 });
  // グローバルカーソルも同一 tick の連続キーで取りこぼさないよう ref で同期更新する
  const cursorRef = useRef<Cursor>(cursor);
  // メインの scrollbox 実体。カーソル追従スクロール（scrollChildIntoView）に使う
  const mainScrollRef = useRef<ScrollBoxRenderable | null>(null);
  // 詳細ペインの scrollbox 実体。詳細にカーソルがあるときの追従スクロールに使う
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const bump = useCallback(() => setConversionVersion((v) => v + 1), []);

  /** カーソルを state と ref に同期更新する（取りこぼし防止 + 表示更新） */
  const moveCursor = useCallback((next: Cursor) => {
    cursorRef.current = next;
    setCursor(next);
  }, []);

  const pipeline = useMemo(
    () =>
      new ConversionPipeline(engine, bump, (m) => setMessage(`変換エラー: ${m}`), {
        corrections,
        cache: conversionCache,
        // 確定した変換を永続化し、次回起動時にシードして全文再変換を避ける
        onConverted: (kana, conv) => {
          saveConversion(db, kana, conv).mapErr((e) => setMessage(`変換保存: ${e.message}`));
        },
      }),
    [engine, corrections, conversionCache, db, bump],
  );

  /** raw（凍結リテラル込み）を確定テキストへ変換する共通処理（保存・確定・凍結で共有） */
  const convertRaw = useCallback(
    (input: string, flush = false) => {
      const applied = pipeline.apply(convertRomaji(input, { flush }).converted);
      return { text: stripPasteMarkers(applied.text), converting: applied.converting };
    },
    [pipeline],
  );

  /** ローマ字 1 文を確定テキストへ変換し、変換が settled かを返す（凍結判定用） */
  const convertSettled = useCallback(
    (sentenceRomaji: string) => {
      const { text, converting } = convertRaw(sentenceRomaji, true);
      return { text, settled: converting === 0 };
    },
    [convertRaw],
  );

  // Tab: 直前の変換単位の候補ローテーション。選択は corrections に学習する
  const rotateLastSegment = useCallback(() => {
    const kana = convertRomaji(bufferRef.current).converted;
    const target = segmentKana(kana)
      .filter((s) => s.complete && !s.separator)
      .at(-1);
    if (target === undefined) {
      return;
    }
    pipeline.rotate(target.text, (chosen) => {
      saveCorrection(db, target.text, chosen).match(
        () => {},
        (e) => setMessage(`学習エラー: ${e.message}`),
      );
    });
  }, [db, pipeline]);

  // タグ・関連の鮮度は前回解析時点でよい（次回の解析で追いつく）。
  // 任意の日付を再エクスポートする（過去チャンク編集後の反映に使う）。
  const exportFor = useCallback(
    (target: string) =>
      getEntryExportChunks(db, target).match(
        (chunks) => exportEntry({ vaultDir, date: target, chunks }),
        (e) => {
          setMessage(`export: ${e.message}`);
          return null;
        },
      ),
    [db, vaultDir],
  );
  const exportCurrent = useCallback(() => exportFor(date), [exportFor, date]);

  /** アンビエント表示: 直近チャンクの関連を更新する（docs/FEATURES.md 候補1） */
  const refreshAmbient = useCallback(
    (vectors: ReadonlyMap<number, Float32Array>) => {
      listChunksWithDate(db).match(
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
    analyzeAll(db).mapErr((e) => setMessage(`解析: ${e.message}`));
    const finish = () => {
      void exportCurrent()?.then((result) =>
        result?.mapErr((e) => setMessage(`export: ${e.message}`)),
      );
    };
    if (embedder === null) {
      finish();
      return;
    }
    void syncChunkEmbeddings(db, embedder)
      .then((synced) =>
        synced
          .andThen(() => loadVectors(db))
          .match(
            (vectors) => {
              addSemanticLinks(db, vectors).mapErr((e) => setMessage(`関連付け: ${e.message}`));
              refreshAmbient(vectors);
            },
            (e) => setMessage(`埋め込み: ${e.message}`),
          ),
      )
      .finally(finish);
  }, [db, embedder, exportCurrent, refreshAmbient]);

  const exit = useCallback(() => {
    // flush 保存（打鍵途中の n を確定）→ エクスポート → 端末復帰。
    // raw が正本なので未確定セグメントの変換完了は待たない（次回起動で回収）。
    const snapshot = {
      date,
      raw: bufferRef.current,
      converted: convertRaw(bufferRef.current, true).text,
    };
    const finish = () => {
      engine.close();
      renderer.destroy();
      process.exit(0);
    };
    persistEntry(db, snapshot).match(() => {
      const exported = exportCurrent();
      if (exported === null) {
        finish();
        return;
      }
      void exported.then(finish, finish);
    }, finish);
  }, [db, date, renderer, engine, convertRaw, exportCurrent]);

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
      getChunkContext(db, chunkId, CONTEXT_RADIUS).match(
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
      editRef.current = { text: block.text, cursor: block.text.length };
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
   * 対象 raw（当日=bufferRef / 過去=DB）から frozenBlockAt で領域を解決する。
   * 末尾の未凍結ライブ文（null）はメイン編集に委ねる。
   */
  const openDetailEdit = useCallback(
    (chunk: ChunkWithDate, viewIndex: number) => {
      const targetRaw =
        chunk.date === date
          ? bufferRef.current
          : getEntryWithChunks(db, chunk.date).match(
              (e) => e?.entry.raw ?? "",
              (e) => {
                setMessage(`読込: ${e.message}`);
                return "";
              },
            );
      const block = frozenBlockAt(targetRaw, chunk.position);
      if (block === null) {
        setMessage("末尾の未確定文はメインで編集してください");
        return;
      }
      editRef.current = { text: block.text, cursor: block.text.length };
      setEditing({
        target: { kind: "detail", date: chunk.date, position: chunk.position, chunkId: chunk.id },
        text: block.text,
        cursor: block.text.length,
        old: block.text,
      });
      moveCursor({ pane: "detail", index: viewIndex, mode: "input" });
    },
    [db, date, moveCursor],
  );

  /**
   * 詳細ペイン経由の確定チャンク編集/削除を、対象エントリの raw に反映する（docs/PANES.md §7）。
   * `nextText` が空文字なら削除（replaceBlock が領域を消す）。当日は bufferRef を正本とし
   * （ライブ末尾を失わない）、過去は DB から raw を再取得して即保存＋当該日を再エクスポートする。
   * stale offset を避けるため、領域は呼び出し時点の raw から `frozenBlockAt` で再解決する。
   */
  const patchDetailChunk = useCallback(
    (chunk: { date: string; position: number }, nextText: string) => {
      if (chunk.date === date) {
        const block = frozenBlockAt(bufferRef.current, chunk.position);
        if (block === null) {
          setMessage("対象チャンクが見つかりません");
          return;
        }
        const next = replaceBlock(bufferRef.current, block.start, block.end, nextText);
        bufferRef.current = next;
        setRaw(next);
        setSaveState("dirty");
        return;
      }
      getEntryWithChunks(db, chunk.date).match(
        (entry) => {
          const targetRaw = entry?.entry.raw ?? "";
          const block = frozenBlockAt(targetRaw, chunk.position);
          if (block === null) {
            setMessage("対象チャンクが見つかりません");
            return;
          }
          const next = replaceBlock(targetRaw, block.start, block.end, nextText);
          persistEntry(db, { date: chunk.date, raw: next, converted: convertRaw(next).text }).match(
            () => {
              const exported = exportFor(chunk.date);
              if (exported !== null) {
                void exported.then((r) => r?.mapErr((e) => setMessage(`export: ${e.message}`)));
              }
            },
            (e) => setMessage(`保存: ${e.message}`),
          );
        },
        (e) => setMessage(`読込: ${e.message}`),
      );
    },
    [db, date, convertRaw, exportFor],
  );

  /**
   * 修正を確定: リテラル領域を打ち直したプレーンテキストで置換する（変換しない）。
   * 空確定は削除しない（元のテキストに戻す＝変更なしで閉じる, docs/PANES.md §4）。
   * 削除は View への d → 確認ダイアログ経由でのみ行う。
   */
  const commitEdit = useCallback(() => {
    const current = editing;
    if (current === null) {
      return;
    }
    const text = current.text.trim();
    const pane = cursorRef.current.pane;
    const index = cursorRef.current.index;
    // 空確定は編集を破棄して元に戻す（削除はしない）。その View（select）へ戻る。
    if (text === "") {
      setEditing(null);
      moveCursor({ pane, index, mode: "select" });
      return;
    }
    if (current.target.kind === "main") {
      const next = replaceBlock(bufferRef.current, current.target.start, current.target.end, text);
      bufferRef.current = next;
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
    patchDetailChunk({ date: targetDate, position }, text);
    // 表示中の詳細を最新へ更新し、当該 detail View(select) にカーソルを戻す
    getChunkContext(db, chunkId, CONTEXT_RADIUS).match(
      (ctx) => setContextChunks(ctx),
      () => {},
    );
    moveCursor({ pane, index, mode: "select" });
  }, [editing, moveCursor, db, patchDetailChunk]);

  /**
   * 確定チャンクの実削除（リテラル領域を空に置換, docs/PANES.md §4）。
   * d 直行・メニュー経由の両方が同じこの経路を通る（重複を避ける）。
   */
  const deleteBlock = useCallback(
    (block: { start: number; end: number }) => {
      const next = replaceBlock(bufferRef.current, block.start, block.end, "");
      bufferRef.current = next;
      setRaw(next);
      setSaveState("dirty");
      // 削除で要素が消えるので clampCursor（レンダー時）が直上 / New へ補正する
      moveCursor({ pane: "main", index: cursorRef.current.index, mode: "select" });
    },
    [moveCursor],
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
   * date+position から領域を再解決し空に置換する。当日は bufferRef、過去は
   * DB 保存＋再エクスポート。削除で要素が消えるため closeExpand しカーソルを関連へ戻す。
   */
  const deleteDetailChunk = useCallback(
    (chunk: ChunkWithDate) => {
      // 空テキストで置換＝削除（patchDetailChunk が当日/過去を分岐）
      patchDetailChunk({ date: chunk.date, position: chunk.position }, "");
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
          pane: cursorRef.current.pane,
          index: cursorRef.current.index,
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
      const next = applyEditKey(editRef.current, keyEvent);
      editRef.current = next;
      setEditing((e) => (e === null ? e : { ...e, text: next.text, cursor: next.cursor }));
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
    const frozenNow = parseBlocks(bufferRef.current).filter((b) => b.frozen);
    const lens: ScreenLens = {
      main: frozenNow.length,
      related: ambient.length,
      detail: contextChunks.length,
    };
    const cur = cursorRef.current;

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
                { label: "編集", onChoose: () => openDetailEdit(chunk, viewIndex) },
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

    const action = applyKey(bufferRef.current, keyEvent);
    switch (action.type) {
      case "exit":
        exit();
        return;
      case "rotate":
        rotateLastSegment();
        return;
      case "open-search":
        // 索引はペインを開いた時点の全チャンクから構築する
        searchIndexRef.current = listChunksWithDate(db).match(
          (chunks) => {
            searchChunksRef.current = new Map(chunks.map((c) => [c.id, c]));
            return buildIndex(chunks);
          },
          (e) => {
            setMessage(`検索: ${e.message}`);
            return null;
          },
        );
        setMode("search");
        return;
      case "edit":
        bufferRef.current = action.raw;
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
    const next = bufferRef.current + wrapPaste(pasted);
    bufferRef.current = next;
    setRaw(next);
    setSaveState("dirty");
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      // 1. 完結・変換済みの文を凍結リテラルへ畳む（末尾の入力中チャンクは残す）
      const frozen = freezeLiveTail(bufferRef.current, convertSettled);
      if (frozen.changed) {
        bufferRef.current = frozen.raw;
        setRaw(frozen.raw);
      }
      const current = bufferRef.current;
      // 2. 永続化（converted から決定的チャンク化）
      const converted = convertRaw(current).text;
      persistEntry(db, { date, raw: current, converted }).match(
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
  }, [db, date, raw, conversionVersion, convertRaw, convertSettled, runBackgroundPass]);

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
  const live = useMemo(() => {
    const { converted, pending } = convertRomaji(liveRaw);
    const applied = pipeline.apply(converted);
    return { text: applied.text, pending, converting: applied.converting };
  }, [liveRaw, conversionVersion, pipeline]);
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
      cursorRef.current = clamped;
      setCursor(clamped);
    }
  }, [clamped, cursor]);

  // メイン表示窓の開始 index（docs/PANES.md §5）。カーソルの 1 件手前から描画し、
  // それより古いチャンクは描画しない。clamped.index は New＝末尾・Edit＝当該・select＝当該
  // をすべて指すため、一律に「1 件手前」で計算できる。
  const windowStart = useMemo(
    () => (clamped.pane === "main" ? Math.max(0, clamped.index - 1) : 0),
    [clamped.pane, clamped.index],
  );

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
  }, [mode, searchQuery]);
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
                <Chunk.Edit text={editing.text} cursor={editing.cursor} />
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
                        <Chunk.Edit text={editing.text} cursor={editing.cursor} />
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
