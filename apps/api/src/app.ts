import { Hono } from "hono";
import type { ControlDb } from "@zakki/api/db/client.ts";
import type { AppDeps } from "./deps.ts";

/** ルートがコンテキスト変数として受け取る依存（api-2 以降が c.get("db") で使う） */
interface ApiEnv {
  Variables: { db: ControlDb };
}

/**
 * コントロールプレーン API の合成（テスト可能な純関数, issue #99）。
 * 依存は {@link AppDeps} で注入する。本番の合成点（env 検証・DB クライアント
 * 生成）は index.ts（apps/web/src/server/app.ts と同じ分離）。
 */
export function createApp(deps: AppDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // 注入された依存をコンテキスト変数で配る。認証・プロビジョニング
  // （api-2 / api-3）のルートが使う
  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    await next();
  });

  // 死活監視のみ（DB ping なしの静的 200）
  app.get("/healthz", (c) => c.json({ ok: true }));

  return app;
}
