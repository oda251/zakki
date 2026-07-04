import { runAnalysisPass } from "@zakki/backend/analysis/pass.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import type { Db } from "@zakki/data/db/client.ts";

/** 保存（キーストローク単位）より粗くてよい解析のデバウンス間隔 */
export const ANALYZE_DEBOUNCE_MS = 2000;

export interface AnalysisScheduler {
  /** 保存成功後に呼ぶ。デバウンスして解析パスを 1 回にまとめる */
  schedule(): void;
  /** 予約中の解析があれば即時実行し、実行中を含め完了を待つ（テスト・シャットダウン用） */
  settle(): Promise<void>;
}

/**
 * runAnalysisPass（TUI の runBackgroundPass と共有）のデバウンス + 直列化。
 * chain で直列化する（analyzeAll の並走による tags 全消し再挿入の競合を避ける）。
 * Obsidian エクスポートはサーバでは行わない（TUI 側の責務のまま）。
 */
export function createAnalysisScheduler(
  db: Db,
  embedder: Embedder | null,
  onError: (message: string) => void,
  debounceMs: number = ANALYZE_DEBOUNCE_MS,
): AnalysisScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const run = () => {
    chain = chain.then(() => runAnalysisPass(db, embedder, onError)).then(() => {});
  };

  return {
    schedule() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, debounceMs);
    },
    settle() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        run();
      }
      return chain;
    },
  };
}
