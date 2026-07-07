import { decodePasteBytes } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { usePaste, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { fmtPolarity, moodColor, scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import { stripPasteMarkers, wrapPaste } from "@zakki/core/conversion/paste.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { persistChildren } from "@zakki/data/chunk/autosave.ts";
import { splitDisplay } from "@zakki/core/entry/records.ts";
import type { Result } from "neverthrow";
import type { Cursor } from "@zakki/core/input/controller.ts";
import { clampInputCursor, screenLens } from "@zakki/core/input/controller.ts";
import { useStore } from "zustand";
import { createEditorStore } from "@zakki/core/input/store.ts";
import { Chunk } from "./chunk.tsx";
import { Dialog, useModals } from "./dialog.tsx";
import { computeBarTarget, useBarCursor, type BarCursorTarget } from "./native-cursor.ts";
import { useAppKeyboard } from "./use-app-keyboard.ts";
import { SearchPane } from "./search-pane.tsx";
import { useAnalysis } from "./use-analysis.ts";
import { useConversionSession } from "./use-conversion.ts";
import { useDetailPane } from "./use-detail-pane.ts";
import { useEditActions } from "./use-edit-actions.ts";
import { useObsidianExport } from "./use-export.ts";
import { useSavePipeline } from "./use-save-pipeline.ts";
import { useSearch } from "./use-search.ts";

/** 関連（アンビエント）パネルの幅 */
const AMBIENT_PANEL_WIDTH = 30;

export interface AppProps {
  db: Db;
  date: string;
  /** 起動時に解決済みの当日の日付チャンク（トップレベル）id。保存のたびの再解決を省く */
  dateChunkId: number;
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

/**
 * TUI のルート（UI 合成、issue #57 で責務を hook 群へ分割）:
 * - 変換セッション配線 …… use-conversion.ts
 * - 保存パイプライン（デバウンス → freeze → convert → persist）…… use-save-pipeline.ts
 * - 解析（デバウンス + 直列化は backend/analysis/scheduler.ts）と関連 …… use-analysis.ts
 * - Obsidian エクスポート …… use-export.ts
 * - 検索 …… use-search.ts / search-pane.tsx
 * - 詳細ペイン …… use-detail-pane.ts
 * - 編集・削除アクション …… use-edit-actions.ts
 * - モーダル状態 …… dialog.tsx（useModals）
 * App 本体はグローバルカーソルのキー配線・表示窓・フッターの合成だけを持つ。
 */
export function App({
  db,
  date,
  dateChunkId,
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
        index: splitDisplay(initialRaw).frozen.length,
        mode: "input",
      },
    }),
  );
  const raw = useStore(store, (s) => s.raw);
  // 変換解決のたびに増え、再描画と再保存（保存パイプラインの依存）を駆動する
  const conversionVersion = useStore(store, (s) => s.conversionVersion);
  const [message, setMessage] = useState("");
  // 単一グローバルカーソル（docs/PANES.md §3）。既定はメインの New（末尾入力）。
  // 初期 index は起動時の確定チャンク数（＝New の位置）。
  const cursor = useStore(store, (s) => s.cursor);
  // 確定チャンクの修正（クリックで開く）。null なら通常入力
  const editing = useStore(store, (s) => s.editing);
  const renderer = useRenderer();
  // メインの scrollbox 実体。カーソル追従スクロール（scrollChildIntoView）に使う
  const mainScrollRef = useRef<ScrollBoxRenderable | null>(null);
  // 詳細ペインの scrollbox 実体。詳細にカーソルがあるときの追従スクロールに使う
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // zustand の action は store 生成時に固定された安定参照。useCallback で包む必要はない。
  // setCursor は「取りこぼし防止＋表示更新」の意味で moveCursor と呼ぶ。
  const { setRaw, setCursor: moveCursor } = store.getState();

  // ── 責務ごとの hook 合成（issue #57）──
  const { conversion, rotateLastSegment } = useConversionSession({
    db,
    engine,
    corrections,
    conversionCache,
    store,
    onMessage: setMessage,
  });
  const { exportFor, exportCurrent } = useObsidianExport({
    db,
    vaultDir,
    date,
    onMessage: setMessage,
  });
  const { ambient, scheduleAnalysis } = useAnalysis({
    db,
    embedder,
    date,
    exportCurrent,
    onMessage: setMessage,
  });
  const { saveState, chunkCount, markDirty } = useSavePipeline({
    db,
    dateChunkId,
    store,
    raw,
    conversionVersion,
    conversion,
    onSaved: scheduleAnalysis,
    onMessage: setMessage,
  });
  const { expandedChunkId, contextChunks, openExpand, closeExpand, refreshContext } = useDetailPane(
    { db, moveCursor, onMessage: setMessage },
  );
  const { dialog, menu, openConfirm, openMenu, handleModalKey, modalOpen } = useModals();
  const { openEdit, openDetailEdit, commitEdit, requestDeleteBlock, requestDeleteDetail } =
    useEditActions({
      db,
      date,
      dateChunkId,
      store,
      exportFor,
      markDirty,
      onMessage: setMessage,
      openConfirm,
      contextChunks,
      expandedChunkId,
      closeExpand,
      refreshContext,
      ambient,
    });
  const search = useSearch({ db, engine, embedder, onMessage: setMessage });

  const exit = useCallback(() => {
    // flush 保存（打鍵途中の n を確定）→ エクスポート → 端末復帰。
    // raw が正本なので未確定セグメントの変換完了は待たない（次回起動で回収）。
    const converted = conversion.convertRaw(store.getState().raw, true).text;
    const finish = () => {
      engine.close();
      renderer.destroy();
      process.exit(0);
    };
    void persistChildren(db, dateChunkId, converted).match(async () => {
      // export の成否に関わらず端末を復帰する（保存は完了済み）
      await exportCurrent();
      // ローカル保存は完了済み。リモート同期はベストエフォートで、失敗しても終了を妨げない
      // （オフライン・未設定は正常系。ローカル専用なら no-op）。
      await sync();
      finish();
    }, finish);
  }, [db, dateChunkId, renderer, engine, conversion, exportCurrent, sync, store]);

  // グローバルカーソルのキー配線（モーダル → 編集中 → 検索 → カーソル intent → 追記入力）
  useAppKeyboard({
    store,
    editing,
    ambient,
    contextChunks,
    expandedChunkId,
    handleModalKey,
    handleSearchKey: search.handleSearchKey,
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
    openSearch: search.openSearch,
    markDirty,
  });

  // ペースト: 変換せずそのまま 1 チャンク（凍結リテラル）に固める
  usePaste((event) => {
    if (modalOpen || editing !== null) {
      return;
    }
    const pasted = decodePasteBytes(event.bytes);
    if (pasted.trim() === "") {
      return;
    }
    const next = store.getState().raw + wrapPaste(pasted);
    setRaw(next);
    markDirty();
  });

  // 表示用の分解: 確定チャンク列（行グループ単位、DB チャンクと 1:1）＋末尾のライブ入力。
  // 凍結リテラル単位（parseBlocks(raw).filter(frozen)）だと同一行の複数リテラルが
  // 別チャンクとして列挙され、liveRaw も末尾リテラル直後の行区切り改行を含んで
  // しまう（#37-1, #37-2）。splitDisplay（liveTailStart + scanLineGroups）に統一する。
  const display = useMemo(() => splitDisplay(raw), [raw]);
  const frozen = display.frozen;
  const liveRaw = display.liveRaw;
  const live = useMemo(
    () => conversion.convertLive(liveRaw),
    [liveRaw, conversionVersion, conversion],
  );
  // 現在のレンズ（メイン / 関連 / 詳細）でカーソルを有効域へ補正する
  // （New 追従・チャンク削除時のフォールバック）。
  const lens = useMemo(
    () => screenLens(frozen.length, ambient.length, contextChunks.length),
    [frozen.length, ambient.length, contextChunks.length],
  );
  // New（入力位置）は末尾に追従させる（clampInputCursor, docs/PANES.md §3）。文の確定
  // （freeze）でチャンクが増減しても New が後ろのチャンクに取り残されない。
  const clamped = useMemo<Cursor>(
    () => clampInputCursor(cursor, lens, editing !== null),
    [cursor, lens, editing],
  );
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
  const barTarget = useMemo<BarCursorTarget | null>(
    () =>
      computeBarTarget({
        mode: search.searchOpen ? "search" : "write",
        hasDialog: dialog !== null,
        hasMenu: menu !== null,
        editing,
        clampedIndex: clamped.index,
        newFocused,
        liveText: live.text + live.pending,
      }),
    [search.searchOpen, dialog, menu, editing, clamped.index, newFocused, live.text, live.pending],
  );

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
    // convertRaw はマーカー温存になったため、解析（表示系）ではここで strip する
    const text = stripPasteMarkers(conversion.convertRaw(raw).text);
    return text.trim() === "" ? null : scoreSentiment(text);
  }, [raw, conversionVersion, conversion]);

  if (search.searchOpen) {
    return (
      <SearchPane
        searchQuery={search.searchQuery}
        queryDisplay={search.queryDisplay}
        bigramHits={search.bigramHits}
        extraSemantic={search.extraSemantic}
      />
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
                text={b.content}
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
