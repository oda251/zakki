import { analyzeAll } from "@zakki/backend/analysis/service.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { addSemanticLinks } from "@zakki/data/embedding/semantic.ts";
import { loadVectors, syncChunkEmbeddings } from "@zakki/data/embedding/store.ts";

/** 保存（キーストローク単位）より粗くてよい解析のデバウンス間隔 */
export const ANALYZE_DEBOUNCE_MS = 2000;

export interface AnalysisScheduler {
  /** 保存成功後に呼ぶ。デバウンスして解析パスを 1 回にまとめる */
  schedule(): void;
  /** 予約済み・実行中の解析の完了を待つ（テスト・シャットダウン用） */
  settle(): Promise<void>;
}

/**
 * TUI の runBackgroundPass 相当（apps/tui/src/tui/App.tsx）: 解析 → 埋め込み → 関連付け。
 * Obsidian エクスポートはサーバでは行わない（TUI 側の責務のまま）。
 * 実行は chain で直列化する（analyzeAll の並走による tags 全消し再挿入の競合を避ける）。
 */
export function createAnalysisScheduler(
  db: Db,
  embedder: Embedder | null,
  onError: (message: string) => void,
  debounceMs: number = ANALYZE_DEBOUNCE_MS,
): AnalysisScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let scheduled: { promise: Promise<void>; resolve: () => void } | null = null;

  async function pass(): Promise<void> {
    await analyzeAll(db).match(
      () => {},
      (e) => onError(`解析: ${e.message}`),
    );
    if (embedder === null) return;
    const synced = await syncChunkEmbeddings(db, embedder);
    await synced
      .asyncAndThen(() => loadVectors(db))
      .match(
        async (vectors) => {
          await addSemanticLinks(db, vectors).match(
            () => {},
            (e) => onError(`関連付け: ${e.message}`),
          );
        },
        (e) => onError(`埋め込み: ${e.message}`),
      );
  }

  return {
    schedule() {
      if (timer !== null) clearTimeout(timer);
      if (scheduled === null) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        scheduled = { promise, resolve };
      }
      timer = setTimeout(() => {
        timer = null;
        const current = scheduled;
        scheduled = null;
        chain = chain.then(pass).finally(() => current?.resolve());
      }, debounceMs);
    },
    settle: () => scheduled?.promise ?? chain,
  };
}
