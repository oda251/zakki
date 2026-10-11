import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStaticRoutes } from "./static.ts";

describe("setupStaticRoutes", () => {
  it("index.html が存在しないディレクトリの場合は false を返しルーティングを設定しない", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "zakki-static-test-"));
    try {
      const app = new Hono();
      const result = setupStaticRoutes(app, tempDir);
      expect(result).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("dist 配下の静的ファイル（sw.js, manifest.webmanifest, assets, SPAルート）を正しく配信する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "zakki-static-test-"));
    try {
      // テスト用ファイルの配置
      writeFileSync(join(tempDir, "index.html"), "<html><body>index</body></html>");
      writeFileSync(join(tempDir, "sw.js"), "self.addEventListener('fetch', () => {});");
      writeFileSync(join(tempDir, "manifest.webmanifest"), '{"name":"zakki"}');

      const app = new Hono();
      const result = setupStaticRoutes(app, tempDir, process.cwd());
      expect(result).toBe(true);

      // 1. GET /sw.js は no-cache, no-store ヘッダ付きで sw.js を返す
      const resSw = await app.request("/sw.js");
      expect(resSw.status).toBe(200);
      expect(await resSw.text()).toBe("self.addEventListener('fetch', () => {});");
      expect(resSw.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");

      // 2. GET /manifest.webmanifest も no-cache, no-store ヘッダ付きで返す
      const resManifest = await app.request("/manifest.webmanifest");
      expect(resManifest.status).toBe(200);
      expect(await resManifest.text()).toBe('{"name":"zakki"}');
      expect(resManifest.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");

      // 3. GET / は index.html を返す
      const resRoot = await app.request("/");
      expect(resRoot.status).toBe(200);
      expect(await resRoot.text()).toBe("<html><body>index</body></html>");
      expect(resRoot.headers.get("cache-control")).toBe("no-cache");

      // 4. 実在しないパス（SPA クライアントルート）は index.html へフォールバック
      const resClientRoute = await app.request("/c/123");
      expect(resClientRoute.status).toBe(200);
      expect(await resClientRoute.text()).toBe("<html><body>index</body></html>");
      expect(resClientRoute.headers.get("cache-control")).toBe("no-cache");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
