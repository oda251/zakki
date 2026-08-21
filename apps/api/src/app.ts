import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiEnv } from "./context.ts";
import type { AppDeps } from "./deps.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes } from "./routes/me.ts";

/**
 * コントロールプレーン API の合成（テスト可能な純関数, issue #99）。
 * 依存は {@link AppDeps} で注入する。本番の合成点（env 検証・DB クライアント
 * 生成）は index.ts（apps/web/src/server/app.ts と同じ分離）。
 */
export function createApp(deps: AppDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // CORS（issue #112 / #134）。Worker は中継サーバとは別オリジンに置く構成なので、
  // ブラウザからの `content-type: application/json` の POST は preflight を通る。
  // 許可するのは **RP origin ちょうど 1 つ**——WebAuthn の origin 検証と同じ値で、
  // ここを緩めるとパスキーの前段だけが別サイトから叩けることになる。
  // credentials（Cookie）は使わない（セッションは Authorization ヘッダの JWT）ので
  // 許可しない。同一オリジン配備でも付いていて害は無い（preflight が来ないだけ）。
  app.use(
    "*",
    cors({
      origin: deps.auth.rpOrigin,
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      maxAge: 86400,
    }),
  );

  // 注入された依存をコンテキスト変数で配る。認証・プロビジョニング
  // （api-2 / api-3）のルートが使う
  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    await next();
  });

  // 死活監視のみ（DB ping なしの静的 200）
  app.get("/healthz", (c) => c.json({ ok: true }));

  // パスキー認証（issue #100）
  app.route("/auth", authRoutes(deps));

  // ユーザごと DB のプロビジョニング（issue #101、要セッション）
  app.route("/me", meRoutes(deps));

  return app;
}
