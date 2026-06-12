import { useKeyboard, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeAll } from "@/analysis/service.ts";
import { saveCorrection } from "@/conversion/corrections.ts";
import type { KanaKanjiEngine } from "@/conversion/engine.ts";
import { ConversionPipeline } from "@/conversion/pipeline.ts";
import { segmentKana } from "@/conversion/segment.ts";
import type { Db } from "@/db/client.ts";
import { persistEntry } from "@/entry/autosave.ts";
import { listChunksWithDate } from "@/entry/queries.ts";
import { getEntryExportChunks } from "@/export/data.ts";
import { exportEntry } from "@/export/obsidian.ts";
import { convertRomaji } from "@/romaji/convert.ts";
import type { SearchIndex } from "@/search/index.ts";
import { buildIndex, searchChunks } from "@/search/index.ts";
import { applyKey, applySearchKey } from "./controller.ts";

/** キーストローク単位の永続化（docs/CONCEPT.md）。打鍵停止後この時間で保存する */
const SAVE_DEBOUNCE_MS = 300;
/** 解析（タグ・関連付け）と vault への反映は保存より粗くてよい */
const ANALYZE_EXPORT_DEBOUNCE_MS = 2000;
const SEARCH_RESULT_LIMIT = 8;

export interface AppProps {
  db: Db;
  date: string;
  initialRaw: string;
  vaultDir: string;
  engine: KanaKanjiEngine;
  /** 学習済みの手動修正（かな → 確定表記）。起動時に corrections テーブルから読む */
  corrections: ReadonlyMap<string, string>;
}

type SaveState = "saved" | "dirty" | "error";

export function App({ db, date, initialRaw, vaultDir, engine, corrections }: AppProps) {
  const [raw, setRaw] = useState(initialRaw);
  // 変換解決のたびに増え、再描画と再保存（effect の依存）を駆動する
  const [conversionVersion, setConversionVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chunkCount, setChunkCount] = useState(0);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"write" | "search">("write");
  const [searchQuery, setSearchQuery] = useState("");
  const searchIndexRef = useRef<SearchIndex | null>(null);
  const renderer = useRenderer();
  const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 入力の正本。キーイベントは同一 tick に連続して届くため、render を待つ
  // state ではなく ref を同期更新して取りこぼしを防ぐ（state は表示用）。
  const bufferRef = useRef(initialRaw);

  const pipeline = useMemo(
    () =>
      new ConversionPipeline(
        engine,
        () => setConversionVersion((v) => v + 1),
        (m) => setMessage(`変換エラー: ${m}`),
        corrections,
      ),
    [engine, corrections],
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
    persistEntry(db, snapshot).match(() => {
      const exported = exportCurrent();
      if (exported === null) {
        finish();
        return;
      }
      void exported.then(finish, finish);
    }, finish);
  }, [db, date, renderer, engine, pipeline, exportCurrent]);

  useKeyboard((keyEvent) => {
    if (mode === "search") {
      const action = applySearchKey(searchQuery, keyEvent);
      switch (action.type) {
        case "close":
          setMode("write");
          setSearchQuery("");
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
          (chunks) => buildIndex(chunks),
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

  useEffect(() => {
    const timer = setTimeout(() => {
      const kana = convertRomaji(raw).converted;
      const snapshot = { date, raw, converted: pipeline.apply(kana).text };
      persistEntry(db, snapshot).match(
        (saved) => {
          setSaveState("saved");
          setChunkCount(saved.chunks.length);
          if (backgroundTimer.current !== null) {
            clearTimeout(backgroundTimer.current);
          }
          backgroundTimer.current = setTimeout(() => {
            // 解析（タグ・関連付け）→ タグ・[[リンク]] 込みでエクスポート
            analyzeAll(db).match(
              () => {},
              (e) => setMessage(`解析: ${e.message}`),
            );
            void exportCurrent()?.then((result) =>
              result?.match(
                () => {},
                (e) => setMessage(`export: ${e.message}`),
              ),
            );
          }, ANALYZE_EXPORT_DEBOUNCE_MS);
        },
        (e) => {
          setSaveState("error");
          setMessage(e.message);
        },
      );
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [db, date, raw, pipeline, conversionVersion, exportCurrent]);

  const { converted: kanaText, pending } = convertRomaji(raw);
  const applied = useMemo(() => pipeline.apply(kanaText), [kanaText, conversionVersion, pipeline]);
  const status =
    saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`;
  const convertingNote = applied.converting > 0 ? ` ｜ 変換中 ${applied.converting}` : "";

  const searchHits = useMemo(() => {
    if (mode !== "search" || searchIndexRef.current === null) {
      return [];
    }
    return searchChunks(searchIndexRef.current, searchQuery).slice(0, SEARCH_RESULT_LIMIT);
  }, [mode, searchQuery]);

  if (mode === "search") {
    const queryDisplay = convertRomaji(searchQuery);
    return (
      <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
        <box style={{ height: 1 }}>
          <text>
            検索: {queryDisplay.converted}
            <span fg="#777777">{queryDisplay.pending}</span>
            <span fg="#aaaaaa">▌</span>
          </text>
        </box>
        <scrollbox style={{ flexGrow: 1 }} focused>
          {searchHits.length === 0 ? (
            <text style={{ fg: "#888888" }}>
              {searchQuery === "" ? "ローマ字で入力すると絞り込まれます" : "該当なし"}
            </text>
          ) : (
            searchHits.map((hit) => (
              <box key={hit.id} style={{ flexDirection: "column", marginBottom: 1 }}>
                <text>
                  <span fg="#88aaff">{hit.date}</span> {hit.title}
                </text>
                <text style={{ fg: "#aaaaaa", wrapMode: "word" }}>{hit.content}</text>
              </box>
            ))
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
      <scrollbox style={{ flexGrow: 1 }} stickyScroll stickyStart="bottom" focused>
        <text style={{ wrapMode: "word" }}>
          {applied.text}
          <span fg="#777777">{pending}</span>
          <span fg="#aaaaaa">▌</span>
        </text>
      </scrollbox>
      <box
        style={{
          height: 1,
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <text style={{ fg: "#888888" }}>
          {date} ｜ チャンク {chunkCount} ｜ {engine.name}
          {convertingNote}
        </text>
        <text style={{ fg: "#888888" }}>{status}</text>
      </box>
    </box>
  );
}
