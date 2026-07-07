import { useCallback, useMemo } from "react";
import type { ConversionSession } from "@zakki/core/conversion/compose.ts";
import { createConversionSession } from "@zakki/core/conversion/compose.ts";
import type { KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import type { EditorStore } from "@zakki/core/input/store.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { saveConversion } from "@zakki/data/conversion/cache.ts";
import { saveCorrection } from "@zakki/data/conversion/corrections.ts";
import type { StoreApi } from "zustand";

/**
 * 変換セッションの配線（issue #57 で App.tsx から切り出し）。
 * 変換合成（機能ロジック）は core と共有し、副作用（永続化・エラー表示）だけ注入する。
 */
export function useConversionSession(options: {
  db: Db;
  engine: KanaKanjiEngine;
  corrections: ReadonlyMap<string, string>;
  conversionCache: ReadonlyMap<string, string>;
  store: StoreApi<EditorStore>;
  onMessage: (message: string) => void;
}): { conversion: ConversionSession; rotateLastSegment: () => void } {
  const { db, engine, corrections, conversionCache, store, onMessage } = options;
  // zustand の action は store 生成時に固定された安定参照
  const { bumpConversion: bump } = store.getState();

  const conversion = useMemo(
    () =>
      createConversionSession(engine, {
        corrections,
        cache: conversionCache,
        onUpdate: bump,
        onError: (m) => onMessage(`変換エラー: ${m}`),
        // 確定した変換を永続化し、次回起動時にシードして全文再変換を避ける
        onConverted: (kana, conv) => {
          void saveConversion(db, kana, conv).mapErr((e) => onMessage(`変換保存: ${e.message}`));
        },
        onChosen: (kana, chosen) => {
          void saveCorrection(db, kana, chosen).match(
            () => {},
            (e) => onMessage(`学習エラー: ${e.message}`),
          );
        },
      }),
    [engine, corrections, conversionCache, db, bump, onMessage],
  );

  // Tab: 直前の変換単位の候補ローテーション。選択は corrections に学習する
  const rotateLastSegment = useCallback(
    () => conversion.rotateLastSegment(store.getState().raw),
    [conversion, store],
  );

  return { conversion, rotateLastSegment };
}
