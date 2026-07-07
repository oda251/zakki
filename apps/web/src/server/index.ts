import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "hono/bun";
import { parseZakkiConfig } from "@zakki/core/config/env.ts";
import { bootstrapServer } from "./bootstrap.ts";

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
const { app, engineName } = await bootstrapServer(config).catch((err: unknown): never => {
  console.error(`zakki-web: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// ビルド済み SPA（vite build → apps/web/dist）があれば配信する（SPA フォールバック付き）。
// 開発時は dist が無くてもよい（vite dev サーバが /api を proxy する）。
// serveStatic の root は cwd 相対のため、import.meta.url 起点で cwd 非依存に解決する。
const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
if (existsSync(join(distDir, "index.html"))) {
  const root = relative(process.cwd(), distDir);
  app.get("/assets/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

const server = Bun.serve({ port: config.webPort, fetch: app.fetch });
console.log(`zakki-web: http://localhost:${server.port} (engine: ${engineName})`);
