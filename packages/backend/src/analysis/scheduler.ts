import { ANALYZE_DEBOUNCE_MS } from "@zakki/core/config/timing.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { runAnalysisPass } from "./pass.ts";

export interface AnalysisScheduler {
  /** 保存成功後に呼ぶ。デバウンスして解析パスを 1 回にまとめる */
  schedule(): void;
  /** 予約中の解析があれば即時実行し、実行中を含め完了を待つ（テスト・シャットダウン用） */
  settle(): Promise<void>;
}

export interface AnalysisSchedulerOptions {
  db: Db;
  embedder: Embedder | null;
  /** 各段の部分失敗をユーザ向け表示へ流す（メッセージは pass.ts 側で整形済み。処理は継続する） */
  onError: (message: string) => void;
  /** デバウンス間隔。省略時は ANALYZE_DEBOUNCE_MS（テストでは 0 を渡す） */
  debounceMs?: number;
  /**
   * 各解析パス完了後に呼ぶ。vectors は同期済みの埋め込み（embedder 無し・失敗時は null）。
   * 呼び出し側固有の後処理（TUI の関連表示更新・Obsidian エクスポート）はここで注入する。
   */
  onSettled?: (vectors: ReadonlyMap<number, Float32Array> | null) => void | Promise<void>;
}

/**
 * runAnalysisPass のデバウンス + 直列化（issue #57 で TUI の手書き setTimeout と統合）。
 * chain で直列化する（解析パスの並走による chunk_tags 差し替えの競合を避ける）。
 * onSettled が Promise を返す場合はそれも chain に含める（後処理ごと直列化される）。
 */
export function createAnalysisScheduler(options: AnalysisSchedulerOptions): AnalysisScheduler {
  const { db, embedder, onError, debounceMs = ANALYZE_DEBOUNCE_MS, onSettled } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const run = () => {
    chain = chain
      .then(() => runAnalysisPass(db, embedder, onError))
      .then((vectors) => onSettled?.(vectors))
      // onSettled の失敗で chain を汚染しない（以降の schedule が動かなくなるのを防ぐ）
      .catch((e: unknown) => onError(errorMessage(e)));
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
