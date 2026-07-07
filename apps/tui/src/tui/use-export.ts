import { useCallback } from "react";
import type { Db } from "@zakki/data/db/client.ts";
import type { Result } from "neverthrow";
import { getEntryExportChunks } from "@zakki/tui/export/data.ts";
import type { ExportError, ExportSummary } from "@zakki/tui/export/obsidian.ts";
import { exportEntry } from "@zakki/tui/export/obsidian.ts";

/**
 * Obsidian エクスポートの配線（issue #57 で App.tsx から切り出し）。
 * タグ・関連の鮮度は前回解析時点でよい（次回の解析で追いつく）。
 */
export function useObsidianExport(options: {
  db: Db;
  vaultDir: string;
  /** 当日（exportCurrent の対象） */
  date: string;
  onMessage: (message: string) => void;
}) {
  const { db, vaultDir, date, onMessage } = options;

  /** 任意の日付を再エクスポートする（過去チャンク編集後の反映に使う） */
  const exportFor = useCallback(
    async (target: string): Promise<Result<ExportSummary, ExportError> | null> => {
      const chunks = await getEntryExportChunks(db, target);
      if (chunks.isErr()) {
        onMessage(`export: ${chunks.error.message}`);
        return null;
      }
      return exportEntry({ vaultDir, date: target, chunks: chunks.value });
    },
    [db, vaultDir, onMessage],
  );
  const exportCurrent = useCallback(() => exportFor(date), [exportFor, date]);

  return { exportFor, exportCurrent };
}
