import { useKeyboard, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KanaKanjiEngine } from "@/conversion/engine.ts";
import { ConversionPipeline } from "@/conversion/pipeline.ts";
import type { Db } from "@/db/client.ts";
import { persistEntry } from "@/entry/autosave.ts";
import { exportEntry } from "@/export/obsidian.ts";
import { convertRomaji } from "@/romaji/convert.ts";
import { applyKey } from "./controller.ts";

/** キーストローク単位の永続化（docs/CONCEPT.md）。打鍵停止後この時間で保存する */
const SAVE_DEBOUNCE_MS = 300;
/** vault への反映は保存より粗くてよい（書きかけ文のファイル churn を抑える） */
const EXPORT_DEBOUNCE_MS = 2000;

export interface AppProps {
  db: Db;
  date: string;
  initialRaw: string;
  vaultDir: string;
  engine: KanaKanjiEngine;
}

type SaveState = "saved" | "dirty" | "error";

export function App({ db, date, initialRaw, vaultDir, engine }: AppProps) {
  const [raw, setRaw] = useState(initialRaw);
  // 変換解決のたびに増え、再描画と再保存（effect の依存）を駆動する
  const [conversionVersion, setConversionVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chunkCount, setChunkCount] = useState(0);
  const [message, setMessage] = useState("");
  const renderer = useRenderer();
  const exportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 入力の正本。キーイベントは同一 tick に連続して届くため、render を待つ
  // state ではなく ref を同期更新して取りこぼしを防ぐ（state は表示用）。
  const bufferRef = useRef(initialRaw);

  const pipeline = useMemo(
    () =>
      new ConversionPipeline(
        engine,
        () => setConversionVersion((v) => v + 1),
        (m) => setMessage(`変換エラー: ${m}`),
      ),
    [engine],
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
    persistEntry(db, snapshot).match((saved) => {
      void exportEntry({ vaultDir, date, chunks: saved.chunks }).then(finish, finish);
    }, finish);
  }, [db, date, vaultDir, renderer, engine, pipeline]);

  useKeyboard((keyEvent) => {
    const action = applyKey(bufferRef.current, keyEvent);
    if (action.type === "exit") {
      exit();
      return;
    }
    if (action.type === "edit") {
      bufferRef.current = action.raw;
      setRaw(action.raw);
      setSaveState("dirty");
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
          if (exportTimer.current !== null) {
            clearTimeout(exportTimer.current);
          }
          exportTimer.current = setTimeout(() => {
            void exportEntry({ vaultDir, date, chunks: saved.chunks }).then((result) =>
              result.match(
                () => {},
                (e) => setMessage(`export: ${e.message}`),
              ),
            );
          }, EXPORT_DEBOUNCE_MS);
        },
        (e) => {
          setSaveState("error");
          setMessage(e.message);
        },
      );
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [db, date, raw, vaultDir, pipeline, conversionVersion]);

  const { converted: kanaText, pending } = convertRomaji(raw);
  const applied = pipeline.apply(kanaText);
  const status =
    saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`;
  const convertingNote = applied.converting > 0 ? ` ｜ 変換中 ${applied.converting}` : "";

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
