import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { MiddlewareHandler } from "hono";
import type { Hono } from "hono";
import type { ServeStaticOptions } from "hono/serve-static";

type StaticMiddlewareFactory = (options: ServeStaticOptions) => MiddlewareHandler;

/**
 * ビルド済み SPA（vite build → apps/web/dist）を配信する（SPA フォールバック付き）。
 *
 * キャッシュ戦略（issue #94 + PWA）:
 * - vite の /assets/* はコンテンツハッシュ付きファイル名なので不変キャッシュ（immutable）
 * - sw.js / manifest.webmanifest はブラウザに即時再検証させるため no-cache, no-store, must-revalidate
 * - その他の静的ファイル（アイコン画像等）も no-cache で配信
 * - ファイルが存在しないパス（SPA ルーティング等）は index.html へフォールバック
 */
export function setupStaticRoutes(
  app: Hono,
  distDir: string,
  staticMiddleware: StaticMiddlewareFactory,
  cwd: string = process.cwd(),
): boolean {
  if (!existsSync(join(distDir, "index.html"))) {
    return false;
  }

  const root = relative(cwd, distDir);

  // 1. /assets/* は不変キャッシュ
  app.get(
    "/assets/*",
    staticMiddleware({
      root,
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );

  // 2. PWA 関連ファイル（sw.js, manifest.webmanifest, アイコン画像など）の実在ファイルを配信
  app.use(
    "*",
    staticMiddleware({
      root,
      onFound: (path, c) => {
        if (path.endsWith("sw.js") || path.endsWith(".webmanifest")) {
          c.header("Cache-Control", "no-cache, no-store, must-revalidate");
        } else {
          c.header("Cache-Control", "no-cache");
        }
      },
    }),
  );

  // 3. SPA フォールバック（実在しないパスは index.html を返す）
  app.get(
    "*",
    staticMiddleware({
      root,
      path: "index.html",
      onFound: (_path, c) => {
        c.header("Cache-Control", "no-cache");
      },
    }),
  );

  return true;
}
