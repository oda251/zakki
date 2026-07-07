import { useCallback, useEffect, useState } from "react";
import { SAVE_DEBOUNCE_MS } from "@zakki/core/config/timing.ts";
import type { ConversionSession } from "@zakki/core/conversion/compose.ts";
import type { EditorStore } from "@zakki/core/input/store.ts";
import { freezeLiveTail } from "@zakki/core/entry/records.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { persistChildren } from "@zakki/data/chunk/autosave.ts";
import type { StoreApi } from "zustand";

export type SaveState = "saved" | "dirty" | "error";

/**
 * 保存パイプライン（issue #57 で App.tsx から切り出し）:
 * デバウンス → 凍結（freeze）→ 変換 → 永続化。保存成功で onSaved（解析スケジュール）を叩く。
 */
export function useSavePipeline(options: {
  db: Db;
  dateChunkId: number;
  store: StoreApi<EditorStore>;
  /** raw / conversionVersion の変化でデバウンス保存を再スケジュールする（effect の依存） */
  raw: string;
  conversionVersion: number;
  conversion: Pick<ConversionSession, "convertRaw" | "convertSettled">;
  /** 保存成功後に呼ぶ（解析スケジューラの schedule） */
  onSaved: () => void;
  onMessage: (message: string) => void;
}) {
  const { db, dateChunkId, store, raw, conversionVersion, conversion, onSaved, onMessage } =
    options;
  const { convertRaw, convertSettled } = conversion;
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [chunkCount, setChunkCount] = useState(0);
  const { setRaw } = store.getState();

  /** raw の編集（保存対象の変化）を dirty 表示に反映する。編集経路（applyKey・ペースト等）が呼ぶ */
  const markDirty = useCallback(() => setSaveState("dirty"), []);

  useEffect(() => {
    const timer = setTimeout(() => {
      // 1. 完結・変換済みの文を凍結リテラルへ畳む（末尾の入力中チャンクは残す）
      const frozen = freezeLiveTail(store.getState().raw, convertSettled);
      if (frozen.changed) {
        setRaw(frozen.raw);
      }
      const current = store.getState().raw;
      // 2. 永続化（converted を Enter 区切りで日付チャンク直下の子チャンクへ投影）
      const converted = convertRaw(current).text;
      void persistChildren(db, dateChunkId, converted).match(
        (saved) => {
          setSaveState("saved");
          setChunkCount(saved?.length ?? 0);
          // 3. 保存より粗い周期のバックグラウンド処理（解析 → 埋め込み → エクスポート）を予約
          onSaved();
        },
        (e) => {
          setSaveState("error");
          onMessage(e.message);
        },
      );
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // conversionVersion: 非同期変換が確定したら再保存・再凍結する
  }, [
    db,
    dateChunkId,
    raw,
    conversionVersion,
    convertRaw,
    convertSettled,
    onSaved,
    onMessage,
    store,
    setRaw,
  ]);

  return { saveState, chunkCount, markDirty };
}
