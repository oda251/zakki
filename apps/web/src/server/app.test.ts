import { beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { Hono } from "hono";
import { createApp } from "./app.ts";

// chunk / graph の読み書き・SSE、およびかな漢字変換のテストは撤去された
// （#44 → #45 で読み書き移行、#26 で変換をクライアント wasm 実行へ移設）。
// 残るサーバ面（封筒・replication・セキュリティヘッダ）のうち、封筒は
// routes/crypto.test.ts、replication は routes/replication.test.ts が担う。

let db: Db;
let app: Hono;

beforeEach(async () => {
  db = await createDb(":memory:");
  app = createApp({ db });
});

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/health", () => {
  test("ok を返す（変換エンジンはサーバから撤去済み #26）", async () => {
    const health = await json<{ ok: boolean }>(await app.request("/api/health"));
    expect(health).toEqual({ ok: true });
  });
});

describe("撤去済みのレガシー読取・書込みルート（#45）", () => {
  test("chunks / graph / events は 404", async () => {
    expect((await app.request(post("/api/chunks/date", {}))).status).toBe(404);
    expect((await app.request("/api/chunks/1")).status).toBe(404);
    expect((await app.request("/api/chunks/1/related")).status).toBe(404);
    expect((await app.request("/api/graph")).status).toBe(404);
    expect((await app.request(post("/api/links", { from: 1, to: 2 }))).status).toBe(404);
    expect((await app.request("/api/events")).status).toBe(404);
  });
});

describe("変換 API は撤去済み（#26 でクライアント wasm 実行へ移設）", () => {
  test("convert / conversion 系ルートは 404", async () => {
    expect((await app.request(post("/api/convert", { kana: "きょう" }))).status).toBe(404);
    expect((await app.request("/api/conversion/state")).status).toBe(404);
    expect(
      (await app.request(post("/api/conversion/cache", { kana: "は", converted: "葉" }))).status,
    ).toBe(404);
  });
});

describe("セキュリティヘッダ（#28 / #43）", () => {
  test("全レスポンスに厳格 CSP（default-src 'self'）が付き、CORS ヘッダは付与しない", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // libsodium の WASM 初期化に必要な最小限のみ script-src へ追加する
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 同一オリジンのみ: CORS を明示的に開放しない
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
