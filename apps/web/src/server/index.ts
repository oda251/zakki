import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "hono/bun";
import { parseZakkiConfig } from "@zakki/core/config/env.ts";
import { ANCO_ASSET_TYPES, ANCO_REF_CACHE, ANCO_REF_FILE, ancoAssetHeaders } from "./anco.ts";
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
const { app } = await bootstrapServer(config).catch((err: unknown): never => {
  console.error(`zakki-web: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// ビルド済み SPA（vite build → apps/web/dist）があれば配信する（SPA フォールバック付き）。
// 開発時は dist が無くてもよい（vite dev サーバが /api を proxy する）。
// serveStatic の root は cwd 相対のため、import.meta.url 起点で cwd 非依存に解決する。
const distDir = fileURLToPath(new URL("../../dist", import.meta.url));

// anco wasm 変換アセット（#26）: reactor wasm と辞書 tar を同一オリジンで配信する。
// ファイルは brotli 済み（.br）なので Content-Encoding: br を付け、ブラウザに透過解凍
// させる（over-the-wire は reactor ~13MB + 辞書 ~7MB）。dist/anco へ install-anco-wasm.sh
// が配置する。SPA フォールバックより前に登録する。
const ancoDir = fileURLToPath(new URL("../../dist/anco", import.meta.url));
// 配信条件（Content-Type・Content-Encoding: br・Cache-Control）は anco.ts が正本で、
// Workers アダプタ（worker.ts）と共有する。片方だけ欠けると壊れ方が分かりにくい
// （Content-Encoding が無いと圧縮バイトがそのまま WebAssembly.compile へ渡る）。
app.get(`/anco/${ANCO_REF_FILE}`, (c) => {
  const path = join(ancoDir, ANCO_REF_FILE);
  if (!existsSync(path)) return c.notFound();
  return new Response(Bun.file(path), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": ANCO_REF_CACHE },
  });
});
app.get("/anco/:file", (c) => {
  const file = c.req.param("file");
  const contentType = ANCO_ASSET_TYPES.get(file);
  const path = join(ancoDir, file);
  if (contentType === undefined || !existsSync(path)) return c.notFound();
  return new Response(Bun.file(path), { headers: ancoAssetHeaders(contentType) });
});

if (existsSync(join(distDir, "index.html"))) {
  const root = relative(process.cwd(), distDir);
  // SPA キャッシュ戦略（issue #94）: vite の /assets/* はコンテンツハッシュ付き
  // ファイル名なので不変キャッシュにする。index.html（SPA フォールバック含む）は
  // no-cache で毎回再検証させ、再デプロイ後に旧バンドル・旧 ref バスティング起点
  // （#89）が残らないようにする。
  app.get(
    "/assets/*",
    serveStatic({
      root,
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.get(
    "*",
    serveStatic({
      root,
      path: "index.html",
      onFound: (_path, c) => {
        c.header("Cache-Control", "no-cache");
      },
    }),
  );
}

const server = Bun.serve({ port: config.webPort, fetch: app.fetch });
console.log(`zakki-web: http://localhost:${server.port}`);
