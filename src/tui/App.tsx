import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
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
import { listChunksWithDate } from "@/entry/queries.ts";
import { freezeLiveTail, frozenCount, parseBlocks, replaceBlock } from "@/entry/records.ts";
import { getEntryExportChunks } from "@/export/data.ts";
import { exportEntry } from "@/export/obsidian.ts";
import { convertRomaji } from "@/romaji/convert.ts";
import type { SearchIndex } from "@/search/index.ts";
import { buildIndex, searchChunks } from "@/search/index.ts";
import { applyKey, applySearchKey } from "./controller.ts";

/** キーストローク単位の永続化（docs/CONCEPT.md）。打鍵停止後この時間で保存する */
const SAVE_DEBOUNCE_MS = 300;
/** 解析（タグ・関連・埋め込み）と vault への反映は保存より粗くてよい */
const ANALYZE_EXPORT_DEBOUNCE_MS = 2000;
const SEARCH_RESULT_LIMIT = 8;
const AMBIENT_LIMIT = 5;
/** 折りたたみ時に表示する確定チャンク数（これ＋入力中チャンクが見える） */
const MIN_VISIBLE_FROZEN = 1;
/** 関連（アンビエント）パネルの幅 */
const AMBIENT_PANEL_WIDTH = 30;
/** 関連を展開したとき、当該チャンクの前後に何件ずつ並べるか */
const CONTEXT_RADIUS = 1;

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

/** 修正中の確定チャンク（記録モデル, docs/RECORDS.md）。raw 内のリテラル領域を打ち直す */
interface Editing {
  /** raw 内のリテラル領域 [start, end) */
  start: number;
  end: number;
  /** 編集バッファ（ローマ字。空のまま確定するとそのチャンクを削除） */
  raw: string;
  /** 参照表示する元の確定テキスト */
  old: string;
}

/**
 * メイン入力ペイン・検索結果・関連の詳細ペインで共有する読み取り用スクロール面。
 * scrollbox の設定（右余白・末尾スティック・フォーカス）を一元化する。
 */
function ReadingPane({
  focused = false,
  stickyBottom = false,
  children,
}: {
  focused?: boolean;
  stickyBottom?: boolean;
  children: ReactNode;
}) {
  return (
    <scrollbox
      // minHeight:0 で flex 親内でも内容に膨らまず、はみ出さずスクロールできる
      style={{ flexGrow: 1, minHeight: 0 }}
      focused={focused}
      stickyScroll={stickyBottom}
      stickyStart={stickyBottom ? "bottom" : undefined}
      // スクロールバーが本文右端の文字に被らないよう、本文側に 1 桁の余白を確保する
      contentOptions={{ paddingRight: 1 }}
    >
      {children}
    </scrollbox>
  );
}

interface AmbientItem {
  chunkId: number;
  date: string;
  /** タイトルは描画時に makeTitle で導出する（派生値は保持しない） */
  content: string;
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
  // フッターに出す当日エントリのネガポジ極性（保存時に算出。空なら null で非表示）
  const [entryMood, setEntryMood] = useState<number | null>(null);
  // 折りたたみ表示: 既定は最新の確定チャンク＋入力中のみ。上下キーで 1 つずつめくる
  const [visibleFrozen, setVisibleFrozen] = useState(MIN_VISIBLE_FROZEN);
  // 確定チャンクの修正（クリックで開く）。null なら通常入力
  const [editing, setEditing] = useState<Editing | null>(null);
  const [mode, setMode] = useState<"write" | "search">("write");
  const [searchQuery, setSearchQuery] = useState("");
  const [semanticHits, setSemanticHits] = useState<ChunkWithDate[]>([]);
  const [ambient, setAmbient] = useState<AmbientItem[]>([]);
  // 関連項目をクリックすると、その投稿の前後を右パネルに展開する（null で一覧表示）
  const [expandedChunkId, setExpandedChunkId] = useState<number | null>(null);
  // 前後チャンクを引くための、日付・position 順に整列した全チャンク（解析時に更新）
  const [allChunks, setAllChunks] = useState<ChunkWithDate[]>([]);
  const searchIndexRef = useRef<SearchIndex | null>(null);
  const searchChunksRef = useRef<Map<number, ChunkWithDate>>(new Map());
  const renderer = useRenderer();
  const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 入力の正本。キーイベントは同一 tick に連続して届くため、render を待つ
  // state ではなく ref を同期更新して取りこぼしを防ぐ（state は表示用）。
  const bufferRef = useRef(initialRaw);
  // 修正バッファも同様に ref で取りこぼしを防ぐ
  const editRawRef = useRef("");

  const bump = useCallback(() => setConversionVersion((v) => v + 1), []);

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

  // タグ・関連の鮮度は前回解析時点でよい（次回の解析で追いつく）
  const exportCurrent = useCallback(
    () =>
      getEntryExportChunks(db, date).match(
        (chunks) => exportEntry({ vaultDir, date, chunks }),
        (e) => {
          setMessage(`export: ${e.message}`);
          return null;
        },
      ),
    [db, date, vaultDir],
  );

  /** アンビエント表示: 直近チャンクの関連を更新する（docs/FEATURES.md 候補1） */
  const refreshAmbient = useCallback(
    (vectors: ReadonlyMap<number, Float32Array>) => {
      listChunksWithDate(db).match(
        (all) => {
          // 前後チャンクの展開に使うため、整列済みの全チャンクを保持する
          setAllChunks(all);
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

  /** 確定チャンクの修正を開く（クリック）。バッファは空（打ち直し）で始める */
  const openEdit = useCallback((block: { start: number; end: number; text: string }) => {
    editRawRef.current = "";
    setEditing({ start: block.start, end: block.end, raw: "", old: block.text });
    setExpandedChunkId(null);
  }, []);

  /** 修正を確定: リテラル領域を打ち直した確定テキストで置換（空なら削除） */
  const commitEdit = useCallback(() => {
    const current = editing;
    if (current === null) {
      return;
    }
    const text = convertRaw(editRawRef.current, true).text.trim();
    const next = replaceBlock(bufferRef.current, current.start, current.end, text);
    bufferRef.current = next;
    setRaw(next);
    setSaveState("dirty");
    setEditing(null);
  }, [editing, convertRaw]);

  useKeyboard((keyEvent) => {
    if (editing !== null) {
      if (keyEvent.name === "escape") {
        setEditing(null);
        return;
      }
      if (keyEvent.name === "return" || keyEvent.name === "enter") {
        commitEdit();
        return;
      }
      const action = applyKey(editRawRef.current, keyEvent);
      if (action.type === "exit") {
        exit();
      } else if (action.type === "edit") {
        editRawRef.current = action.raw;
        setEditing((e) => (e === null ? e : { ...e, raw: action.raw }));
      }
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
      case "reveal-older": {
        const max = frozenCount(bufferRef.current);
        setVisibleFrozen((n) => Math.min(n + 1, max));
        return;
      }
      case "reveal-newer":
        setVisibleFrozen((n) => Math.max(MIN_VISIBLE_FROZEN, n - 1));
        return;
      case "collapse":
        setVisibleFrozen(MIN_VISIBLE_FROZEN);
        setExpandedChunkId(null);
        return;
      case "edit":
        bufferRef.current = action.raw;
        setRaw(action.raw);
        setSaveState("dirty");
        setVisibleFrozen(MIN_VISIBLE_FROZEN);
        return;
      case "none":
        return;
    }
  });

  // ペースト: 変換せずそのまま 1 チャンク（凍結リテラル）に固める
  usePaste((event) => {
    if (editing !== null) {
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
    setVisibleFrozen(MIN_VISIBLE_FROZEN);
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
      setEntryMood(converted.trim() === "" ? null : scoreSentiment(converted));
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

  // セマンティック検索（docs/FEATURES.md 候補8）: クエリをかな→漢字→埋め込みして近傍検索。
  useEffect(() => {
    const active = mode === "search" && embedder !== null && searchQuery !== "";
    if (!active) {
      setSemanticHits([]);
    }
    const timer = setTimeout(() => {
      if (!active || embedder === null) {
        return;
      }
      const kana = convertRomaji(searchQuery, { flush: true }).converted;
      void (async () => {
        const text = (await engine.convert(kana)).match(
          (candidates) => candidates[0] ?? kana,
          () => kana,
        );
        const [queryVector] = await embedder.embed([text]).catch(() => []);
        if (queryVector === undefined) {
          return;
        }
        loadVectors(db).match(
          (vectors) => {
            const byId = searchChunksRef.current;
            const hits = nearestChunks(vectors, queryVector, SEARCH_RESULT_LIMIT).flatMap((n) => {
              const chunk = byId.get(n.chunkId);
              return chunk === undefined ? [] : [chunk];
            });
            setSemanticHits(hits);
          },
          () => {},
        );
      })();
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
  const shownFrozenCount = Math.min(visibleFrozen, frozen.length);
  const shownFrozen = frozen.slice(frozen.length - shownFrozenCount);
  const hiddenCount = frozen.length - shownFrozenCount;

  const status =
    saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`;
  const convertingNote = live.converting > 0 ? ` ｜ 変換中 ${live.converting}` : "";

  const contextChunks = useMemo(() => {
    if (expandedChunkId === null) {
      return [];
    }
    const i = allChunks.findIndex((c) => c.id === expandedChunkId);
    if (i === -1) {
      return [];
    }
    return allChunks.slice(Math.max(0, i - CONTEXT_RADIUS), i + CONTEXT_RADIUS + 1);
  }, [expandedChunkId, allChunks]);

  const bigramHits = useMemo(() => {
    if (mode !== "search" || searchIndexRef.current === null) {
      return [];
    }
    return searchChunks(searchIndexRef.current, searchQuery).slice(0, SEARCH_RESULT_LIMIT);
  }, [mode, searchQuery]);
  const queryDisplay = useMemo(() => convertRomaji(searchQuery), [searchQuery]);
  const editDisplay = useMemo(() => convertRomaji(editing?.raw ?? ""), [editing?.raw]);
  const editText = useMemo(
    () => pipeline.apply(editDisplay.converted).text,
    [editDisplay, pipeline],
  );

  // 修正モード: 確定チャンクを打ち直す（メイン入力ペインの編集版）
  if (editing !== null) {
    return (
      <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
        <box style={{ height: 1 }}>
          <text style={{ fg: "#666666" }}>修正前: {editing.old}</text>
        </box>
        <ReadingPane focused>
          <text style={{ wrapMode: "word" }}>
            {editText}
            <span fg="#777777">{editDisplay.pending}</span>
            <span fg="#aaaaaa">▌</span>
          </text>
        </ReadingPane>
        <box style={{ height: 1 }}>
          <text style={{ fg: "#888888" }}>Enter で確定 ｜ Esc で取消（空のまま確定で削除）</text>
        </box>
      </box>
    );
  }

  if (mode === "search") {
    const seen = new Set(bigramHits.map((h) => h.id));
    const extraSemantic = semanticHits.filter((h) => !seen.has(h.id)).slice(0, 4);
    return (
      <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
        <box style={{ height: 1 }}>
          <text>
            検索: {queryDisplay.converted}
            <span fg="#777777">{queryDisplay.pending}</span>
            <span fg="#aaaaaa">▌</span>
          </text>
        </box>
        <ReadingPane focused>
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
        </ReadingPane>
        <box style={{ height: 1 }}>
          <text style={{ fg: "#888888" }}>Esc で戻る</text>
        </box>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <ReadingPane focused stickyBottom>
          {hiddenCount > 0 && (
            <text style={{ fg: "#555555" }}>… ↑ で履歴（あと {hiddenCount}） ──</text>
          )}
          {/* 確定チャンク: クリックで修正（打ち直し）。1 チャンク 1 行 */}
          {shownFrozen.map((b) => (
            <box key={b.start} onMouseDown={() => openEdit(b)}>
              <text style={{ fg: "#cccccc", wrapMode: "word" }}>{b.text}</text>
            </box>
          ))}
          {/* 入力中チャンク（ライブ）: 変換しつつカーソルを出す */}
          <text style={{ wrapMode: "word" }}>
            {live.text}
            <span fg="#777777">{live.pending}</span>
            <span fg="#aaaaaa">▌</span>
          </text>
        </ReadingPane>
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
              {ambient.map((item) => {
                const active = item.chunkId === expandedChunkId;
                return (
                  <box key={item.chunkId} onMouseDown={() => setExpandedChunkId(item.chunkId)}>
                    <text style={{ fg: active ? "#ffffff" : "#aaaaaa", wrapMode: "char" }}>
                      <span fg="#88aaff">{item.date}</span> {makeTitle(item.content)}
                    </text>
                  </box>
                );
              })}
            </box>
            {expandedChunkId !== null && (
              <box style={{ flexDirection: "column", flexGrow: 1, minHeight: 0, marginTop: 1 }}>
                <box style={{ flexShrink: 0 }} onMouseDown={() => setExpandedChunkId(null)}>
                  <text style={{ fg: "#666666" }}>── 詳細（Esc で閉じる） ──</text>
                </box>
                <ReadingPane>
                  <text style={{ wrapMode: "word" }}>
                    {contextChunks.map((c, idx) => (
                      <span key={c.id} fg={c.id === expandedChunkId ? "#cccccc" : "#666666"}>
                        {idx > 0 ? `\n${c.content}` : c.content}
                      </span>
                    ))}
                  </text>
                </ReadingPane>
              </box>
            )}
          </box>
        )}
      </box>
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
    </box>
  );
}
