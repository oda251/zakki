import { beforeEach, describe, expect, test } from "bun:test";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { Hono } from "hono";
import type { ConversionStateResponse, ConvertResponse } from "@zakki/web/shared/api-types.ts";
import { createApp } from "./app.ts";

// chunk / graph の読み書き・SSE のテストは RxDB replication（+ liveQuery）への
// 移行（#44 → #45）でルートごと撤去された。残るサーバ面（変換・封筒・replication・
// セキュリティヘッダ）のうち、封筒は routes/crypto.test.ts、replication は
// routes/replication.test.ts が担う。

let db: Db;
let app: Hono;

beforeEach(async () => {
  db = await createDb(":memory:");
  app = createApp({ db, engine: identityEngine });
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
  test("エンジン名を返す（embedder はサーバから撤去済み #45）", async () => {
    const health = await json<{ engine: string }>(await app.request("/api/health"));
    expect(health).toEqual({ engine: "identity" });
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

describe("変換 API", () => {
  test("convert は候補列を返す（identity はかなを素通し）", async () => {
    const res = await json<ConvertResponse>(
      await app.request(post("/api/convert", { kana: "きょうははれ" })),
    );
    expect(res.candidates).toEqual(["きょうははれ"]);
  });

  test("conversion/state は corrections と cache を返す", async () => {
    await json(
      await app.request(post("/api/conversion/corrections", { kana: "き", chosen: "木" })),
    );
    await json(
      await app.request(post("/api/conversion/cache", { kana: "はれ", converted: "晴れ" })),
    );
    const state = await json<ConversionStateResponse>(await app.request("/api/conversion/state"));
    expect(state.corrections).toEqual({ き: "木" });
    expect(state.cache).toEqual({ はれ: "晴れ" });
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
