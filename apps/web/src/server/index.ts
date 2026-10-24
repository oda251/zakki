import { fileURLToPath } from "node:url";
import { parseZakkiConfig } from "@zakki/core/config/env.ts";
import { serveStatic } from "hono/bun";
import { bootstrapServer } from "./bootstrap.ts";
import { setupStaticRoutes } from "./static.ts";

// Bun 用起動アダプタ（issue #29）。Bun 固有 API（Bun.serve・hono/bun の静的配信）は
// このファイルに閉じ、サーバ本体の合成は標準 Fetch ベースの bootstrap.ts が担う。

// 環境変数はここで一度だけスキーマ検証し、以降は型付き config を注入する（issue #48）。
// 不正な値（例: ZAKKI_WEB_PORT=abc）は変数名を示して即終了する。
const config = parseZakkiConfig(process.env).match(
  (c) => c,
  (message): never => {
    console.error(`zakki-web: ${message}`);
    process.exit(1);
  },
);

// アンロック失敗・暗号ガード違反（issue #46）等は起動不能として即終了する。
const { app } = await bootstrapServer(config).catch((err: unknown): never => {
  console.error(`zakki-web: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// ビルド済み SPA（vite build → apps/web/dist）があれば配信する（SPA フォールバック付き）。
// 開発時は dist が無くてもよい（vite dev サーバが /api を proxy する）。
const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
setupStaticRoutes(app, distDir, serveStatic);

const server = Bun.serve({ port: config.webPort, fetch: app.fetch });
console.log(`zakki-web: http://localhost:${server.port}`);
