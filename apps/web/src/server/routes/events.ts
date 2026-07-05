import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppDeps } from "@zakki/web/server/deps.ts";

/** 接続維持 ping の間隔（プロキシ・LB のアイドル切断対策。クラウド配置でも成立する値） */
const PING_INTERVAL_MS = 25_000;

/**
 * GET /api/events (SSE): 解析完了イベントの push。クライアントはこれを合図に
 * グラフ・関連を再取得する（固定タイマーのポーリング廃止, docs/COMPOSER.md）。
 */
export function eventRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = deps.events.subscribe(() => {
        stream.writeSSE({ event: "analysis", data: "settled" }).catch(() => {});
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(PING_INTERVAL_MS);
      }
    }),
  );

  return app;
}
