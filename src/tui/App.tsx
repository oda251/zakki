import { decodePasteBytes } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { analyzeAll } from "@/analysis/service.ts";
import { countChunks, displayTail } from "@/chunk/chunker.ts";
import { TopicGrouper } from "@/chunk/grouper.ts";
import { fmtPolarity, moodIcon, scoreSentiment } from "@/analysis/sentiment.ts";
import { saveConversion } from "@/conversion/cache.ts";
import { saveCorrection } from "@/conversion/corrections.ts";
import type { KanaKanjiEngine } from "@/conversion/engine.ts";
import { PASTE_CLOSE, PASTE_OPEN, stripPasteMarkers, wrapPaste } from "@/conversion/paste.ts";
import { ConversionPipeline } from "@/conversion/pipeline.ts";
import { segmentKana } from "@/conversion/segment.ts";
import type { Db } from "@/db/client.ts";
import type { Embedder } from "@/embedding/embedder.ts";
import { addSemanticLinks, nearestChunks } from "@/embedding/semantic.ts";
import { loadVectors, syncChunkEmbeddings } from "@/embedding/store.ts";
import { persistEntry } from "@/entry/autosave.ts";
import type { ChunkWithDate } from "@/entry/queries.ts";
import { listChunksWithDate } from "@/entry/queries.ts";
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
const AMBIENT_LIMIT = 3;
/** 折りたたみ時に表示する末尾チャンク数（最新の確定チャンク＋入力中チャンク） */
const MIN_VISIBLE_CHUNKS = 2;

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
  /** ローカル embedding。null なら話題検出・セマンティック機能は無効（決定的動作のみ） */
  embedder: Embedder | null;
}

type SaveState = "saved" | "dirty" | "error";

interface AmbientItem {
  date: string;
  title: string;
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
  // 変換・グルーピング解決のたびに増え、再描画と再保存（effect の依存）を駆動する
  const [conversionVersion, setConversionVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chunkCount, setChunkCount] = useState(0);
  const [message, setMessage] = useState("");
  // フッターに出す当日エントリのネガポジ極性（保存時に算出。空なら null で非表示）
  const [entryMood, setEntryMood] = useState<number | null>(null);
  // 折りたたみ表示: 既定は最新＋入力中チャンクのみ。上下キーで 1 チャンクずつめくる
  const [visibleChunks, setVisibleChunks] = useState(MIN_VISIBLE_CHUNKS);
  // 表示数クランプ用の総チャンク数（描画時に更新し、キーハンドラから参照する）
  const totalChunksRef = useRef(MIN_VISIBLE_CHUNKS);
  const [mode, setMode] = useState<"write" | "search">("write");
  const [searchQuery, setSearchQuery] = useState("");
  const [semanticHits, setSemanticHits] = useState<ChunkWithDate[]>([]);
  const [ambient, setAmbient] = useState<AmbientItem[]>([]);
  const searchIndexRef = useRef<SearchIndex | null>(null);
  const searchChunksRef = useRef<Map<number, ChunkWithDate>>(new Map());
  const renderer = useRenderer();
  const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 入力の正本。キーイベントは同一 tick に連続して届くため、render を待つ
  // state ではなく ref を同期更新して取りこぼしを防ぐ（state は表示用）。
  const bufferRef = useRef(initialRaw);

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

  const grouper = useMemo(
    () =>
      embedder === null ? undefined : new TopicGrouper((texts) => embedder.embed(texts), bump),
    [embedder, bump],
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
              return chunk === undefined ? [] : [{ date: chunk.date, title: chunk.title }];
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
    // 未変換セグメントの変換完了は待たない（raw が正本なので次回起動で回収）
    const kana = convertRomaji(bufferRef.current, { flush: true }).converted;
    const snapshot = {
      date,
      raw: bufferRef.current,
      converted: pipeline.apply(kana).text,
    };
    const finish = () => {
      engine.close();
      renderer.destroy();
      process.exit(0);
    };
    persistEntry(db, snapshot, grouper).match(() => {
      const exported = exportCurrent();
      if (exported === null) {
        finish();
        return;
      }
      void exported.then(finish, finish);
    }, finish);
  }, [db, date, renderer, engine, pipeline, grouper, exportCurrent]);

  useKeyboard((keyEvent) => {
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
      case "reveal-older":
        // 1 つ上のチャンクを追加表示（総数を超えない）
        setVisibleChunks((n) => Math.min(n + 1, totalChunksRef.current));
        return;
      case "reveal-newer":
        // 1 つ畳む（最新＋入力中の 2 つを下限とする）
        setVisibleChunks((n) => Math.max(MIN_VISIBLE_CHUNKS, n - 1));
        return;
      case "collapse":
        setVisibleChunks(MIN_VISIBLE_CHUNKS);
        return;
      case "edit":
        bufferRef.current = action.raw;
        setRaw(action.raw);
        setSaveState("dirty");
        // 打鍵したら折りたたみ表示（末尾）へ復帰する
        setVisibleChunks(MIN_VISIBLE_CHUNKS);
        return;
      case "none":
        return;
    }
  });

  // ペースト: 変換せずそのまま 1 チャンクに固める（内部の句点・改行で分割しない）
  usePaste((event) => {
    const wrapped = wrapPaste(decodePasteBytes(event.bytes));
    if (wrapped.length <= PASTE_OPEN.length + PASTE_CLOSE.length) {
      return;
    }
    const next = bufferRef.current + wrapped;
    bufferRef.current = next;
    setRaw(next);
    setSaveState("dirty");
    setVisibleChunks(MIN_VISIBLE_CHUNKS);
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      const kana = convertRomaji(raw).converted;
      const snapshot = { date, raw, converted: pipeline.apply(kana).text };
      // 当日エントリ全体のネガポジ極性をフッター用に更新（空なら非表示）
      const stripped = stripPasteMarkers(snapshot.converted);
      setEntryMood(stripped.trim() === "" ? null : scoreSentiment(stripped));
      persistEntry(db, snapshot, grouper).match(
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
  }, [db, date, raw, pipeline, grouper, conversionVersion, runBackgroundPass]);

  // セマンティック検索（docs/FEATURES.md 候補8）: クエリをかな→漢字→埋め込みして近傍検索。
  // かな文の埋め込みは弱い（実測）ため、変換エンジンで漢字に開いてから埋め込む
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

  const { converted: kanaText, pending } = convertRomaji(raw);
  const applied = useMemo(() => pipeline.apply(kanaText), [kanaText, conversionVersion, pipeline]);
  // 既定は最新＋入力中チャンクのみ。上下キーでめくった visibleChunks 分だけ表示する
  const totalChunks = useMemo(() => countChunks(applied.text), [applied.text]);
  totalChunksRef.current = totalChunks;
  const shownChunks = Math.min(visibleChunks, totalChunks);
  const shownText = useMemo(
    () => displayTail(applied.text, shownChunks),
    [shownChunks, applied.text],
  );
  const hiddenChunks = totalChunks - shownChunks;
  const status =
    saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`;
  const convertingNote = applied.converting > 0 ? ` ｜ 変換中 ${applied.converting}` : "";

  const bigramHits = useMemo(() => {
    if (mode !== "search" || searchIndexRef.current === null) {
      return [];
    }
    return searchChunks(searchIndexRef.current, searchQuery).slice(0, SEARCH_RESULT_LIMIT);
  }, [mode, searchQuery]);

  if (mode === "search") {
    const queryDisplay = convertRomaji(searchQuery);
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
        <scrollbox style={{ flexGrow: 1 }} focused contentOptions={{ paddingRight: 1 }}>
          {bigramHits.length === 0 && extraSemantic.length === 0 ? (
            <text style={{ fg: "#888888" }}>
              {searchQuery === "" ? "ローマ字で入力すると絞り込まれます" : "該当なし"}
            </text>
          ) : (
            <Fragment>
              {bigramHits.map((hit) => (
                <box key={hit.id} style={{ flexDirection: "column", marginBottom: 1 }}>
                  <text>
                    <span fg="#88aaff">{hit.date}</span> {hit.title}
                  </text>
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
                        <span fg="#88aaff">{hit.date}</span> {hit.title}
                      </text>
                    </box>
                  ))}
                </Fragment>
              )}
            </Fragment>
          )}
        </scrollbox>
        <box style={{ height: 1 }}>
          <text style={{ fg: "#888888" }}>Esc で戻る</text>
        </box>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <scrollbox
          style={{ flexGrow: 1 }}
          stickyScroll
          stickyStart="bottom"
          focused
          // スクロールバーが本文右端の文字に被らないよう、本文側に 1 桁の余白を確保する
          contentOptions={{ paddingRight: 1 }}
        >
          {hiddenChunks > 0 && (
            <text style={{ fg: "#555555" }}>… ↑ で履歴（あと {hiddenChunks}） ──</text>
          )}
          <text style={{ wrapMode: "word" }}>
            {shownText}
            <span fg="#777777">{pending}</span>
            <span fg="#aaaaaa">▌</span>
          </text>
        </scrollbox>
        {ambient.length > 0 && (
          <box style={{ width: 30, flexDirection: "column", paddingLeft: 1 }}>
            <text style={{ fg: "#666666" }}>── 関連 ──</text>
            {ambient.map((item, i) => (
              <text key={i} style={{ fg: "#aaaaaa", wrapMode: "word" }}>
                <span fg="#88aaff">{item.date}</span> {item.title}
              </text>
            ))}
          </box>
        )}
      </box>
      <box
        style={{
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <text style={{ fg: "#888888" }}>
          {date} ｜ チャンク {chunkCount}
          {entryMood !== null && ` ｜ ${moodIcon(entryMood)} ${fmtPolarity(entryMood)}`} ｜{" "}
          {engine.name}
          {convertingNote}
        </text>
        <text style={{ fg: "#888888" }}>{status}</text>
      </box>
    </box>
  );
}
