import { useCallback, useMemo, useState } from "react";
import { createAnalysisScheduler } from "@zakki/backend/analysis/scheduler.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { listChunksWithDate } from "@zakki/data/chunk/queries.ts";
import type { Result } from "neverthrow";
import type { ExportError, ExportSummary } from "@zakki/tui/export/obsidian.ts";
import { selectAmbient, type AmbientItem } from "./ambient.ts";

const AMBIENT_LIMIT = 5;

/**
 * 解析スケジューリングの配線（issue #57 で App.tsx から切り出し）。
 *
 * デバウンス + 直列化は backend の AnalysisScheduler に一本化し、TUI 固有の
 * 「解析後の関連（アンビエント）更新と当日 Obsidian エクスポート」を onSettled で注入する。
 */
export function useAnalysis(options: {
  db: Db;
  embedder: Embedder | null;
  /** 当日（アンビエント選定の基準日） */
  date: string;
  exportCurrent: () => Promise<Result<ExportSummary, ExportError> | null>;
  onMessage: (message: string) => void;
}) {
  const { db, embedder, date, exportCurrent, onMessage } = options;
  const [ambient, setAmbient] = useState<AmbientItem[]>([]);

  /** アンビエント表示: 直近チャンクの関連を更新する（docs/FEATURES.md 候補1） */
  const refreshAmbient = useCallback(
    (vectors: ReadonlyMap<number, Float32Array>) => {
      void listChunksWithDate(db).match(
        (all) => setAmbient(selectAmbient(all, vectors, date, AMBIENT_LIMIT)),
        () => {},
      );
    },
    [db, date],
  );

  // 依存はすべて安定（props とローカル useCallback）なので実質マウント時に 1 回だけ生成される。
  // 解析より粗い後処理（エクスポート）は成否に関わらず走らせる（従来の finally と同じ）。
  const scheduler = useMemo(
    () =>
      createAnalysisScheduler({
        db,
        embedder,
        onError: onMessage,
        onSettled: async (vectors) => {
          if (vectors !== null) {
            refreshAmbient(vectors);
          }
          const result = await exportCurrent();
          result?.mapErr((e) => onMessage(`export: ${e.message}`));
        },
      }),
    [db, embedder, refreshAmbient, exportCurrent, onMessage],
  );

  /** 保存成功後に呼ぶ（デバウンスして解析パスを 1 回にまとめる） */
  const scheduleAnalysis = useCallback(() => {
    scheduler.schedule();
  }, [scheduler]);

  return { ambient, scheduleAnalysis };
}
