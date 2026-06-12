import { useKeyboard, useRenderer } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Db } from "@/db/client.ts";
import { persistEntry } from "@/entry/autosave.ts";
import { exportEntry } from "@/export/obsidian.ts";
import { applyKey, deriveDisplay, snapshotFromRaw } from "./controller.ts";

/** キーストローク単位の永続化（docs/CONCEPT.md）。打鍵停止後この時間で保存する */
const SAVE_DEBOUNCE_MS = 300;
/** vault への反映は保存より粗くてよい（書きかけ文のファイル churn を抑える） */
const EXPORT_DEBOUNCE_MS = 2000;

export interface AppProps {
  db: Db;
  date: string;
  initialRaw: string;
  vaultDir: string;
}

type SaveState = "saved" | "dirty" | "error";

export function App({ db, date, initialRaw, vaultDir }: AppProps) {
  const [raw, setRaw] = useState(initialRaw);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chunkCount, setChunkCount] = useState(0);
  const [message, setMessage] = useState("");
  const renderer = useRenderer();
  const exportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 入力の正本。キーイベントは同一 tick に連続して届くため、render を待つ
  // state ではなく ref を同期更新して取りこぼしを防ぐ（state は表示用）。
  const bufferRef = useRef(initialRaw);

  const exit = useCallback(() => {
    // flush 保存（打鍵途中の n を確定）→ エクスポート → 端末復帰
    const snapshot = snapshotFromRaw(date, bufferRef.current, { flush: true });
    const finish = () => {
      renderer.destroy();
      process.exit(0);
    };
    persistEntry(db, snapshot).match((saved) => {
      void exportEntry({ vaultDir, date, chunks: saved.chunks }).then(finish, finish);
    }, finish);
  }, [db, date, vaultDir, renderer]);

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
      persistEntry(db, snapshotFromRaw(date, raw)).match(
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
  }, [db, date, raw, vaultDir]);

  const display = deriveDisplay(raw);
  const status =
    saveState === "saved" ? "保存済み" : saveState === "dirty" ? "…" : `エラー: ${message}`;

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <scrollbox style={{ flexGrow: 1 }} stickyScroll stickyStart="bottom" focused>
        <text style={{ wrapMode: "word" }}>
          {display.converted}
          <span fg="#777777">{display.pending}</span>
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
          {date} ｜ チャンク {chunkCount}
        </text>
        <text style={{ fg: "#888888" }}>{status}</text>
      </box>
    </box>
  );
}
