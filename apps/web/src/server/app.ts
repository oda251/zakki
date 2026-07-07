import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { API_BASE } from "@zakki/web/shared/api-base.ts";
import type { AppDeps } from "./deps.ts";
import { conversionRoutes } from "./routes/convert.ts";
import { cryptoRoutes } from "./routes/crypto.ts";
import { replicationRoutes } from "./routes/replication.ts";

/**
 * API アプリの合成（テスト可能な純関数）。依存は {@link AppDeps} で注入する。
 * 本番の合成点（DB を開く・暗号アンロック・エンジン選択）は index.ts。
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // セキュリティヘッダ（#28 / #43）。SPA 配信（index.ts の serveStatic）も同じ app を
  // 通るため、API・静的資産の両方に効く。CORS ミドルウェアは意図的に置かない
  // （ヘッダ不在 = ブラウザ既定で同一オリジンのみ）。バンドルは自己完結（CDN 不使用）が前提。
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // libsodium-wrappers の WASM 初期化（WebAssembly.instantiate）に必要な最小限
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        // React の style 属性（inline style）用。外部スタイルは 'self' のみ
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // chunk / graph の読み書き・SSE は RxDB replication（+ liveQuery）へ移行済みで
  // 撤去された（#44 → #45）。残るのは replication で代替できないサーバ機能のみ:
  // 変換エンジン（anco, #26 でクライアント移設予定）・封筒配布・replication 中継。
  const api = new Hono();

  api.get("/health", (c) => c.json({ engine: deps.engine.name }));
  api.route("/", conversionRoutes(deps));
  api.route("/replication", replicationRoutes(deps));
  api.route("/crypto", cryptoRoutes(deps));

  app.route(API_BASE, api);
  return app;
}
