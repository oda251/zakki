import { Hono } from "hono";
import type { AppDeps } from "./deps.ts";
import { conversionRoutes } from "./routes/convert.ts";
import { graphRoutes } from "./routes/graph.ts";
import { sessionRoutes } from "./routes/sessions.ts";

/**
 * API アプリの合成（テスト可能な純関数）。依存は {@link AppDeps} で注入する。
 * 本番の合成点（DB を開く・暗号アンロック・エンジン選択）は index.ts。
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const api = new Hono();

  api.get("/health", (c) => c.json({ engine: deps.engine.name, embedder: deps.embedder !== null }));
  api.route("/sessions", sessionRoutes(deps));
  api.route("/", conversionRoutes(deps));
  api.route("/", graphRoutes(deps));

  app.route("/api", api);
  return app;
}
