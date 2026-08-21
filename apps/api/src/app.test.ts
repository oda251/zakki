import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/core/turso/platform.ts";
import { createApp } from "./app.ts";

/**
 * fetch ハンドラ直叩きの検証（issue #99）。DB は本物の libsql（in-memory）を
 * 注入する（~/.references/policy/testing.md: ローカルで再現できる依存は本物）。
 */

function makeApp() {
  const db = drizzle(createClient({ url: ":memory:" }), { schema });
  return createApp({
    db,
    auth: { rpId: "zakki.test", rpOrigin: "https://zakki.test", sessionSecret: "test-secret" },
    // このスイートは /me/db を叩かないので、到達不能な base URL でよい
    // （プロビジョニング本体の検証は routes/me.test.ts）
    turso: createTursoPlatform({
      baseUrl: "http://127.0.0.1:1",
      apiToken: "unused",
      organization: "unused",
      group: "unused",
    }),
  });
}

describe("createApp", () => {
  test("GET /healthz は 200 で { ok: true } を返す（DB ping なし）", async () => {
    const res = await makeApp().fetch(new Request("http://control.test/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("未知のパスは 404", async () => {
    const res = await makeApp().fetch(new Request("http://control.test/nowhere"));
    expect(res.status).toBe(404);
  });
});

/**
 * CORS（issue #112 / #134）。Worker は中継サーバとは別オリジンに置くので、
 * ブラウザの JSON POST は preflight を通る。許可は RP origin ちょうど 1 つ。
 */
describe("CORS", () => {
  test("RP origin からの preflight は許可される", async () => {
    const res = await makeApp().fetch(
      new Request("http://control.test/auth/login/options", {
        method: "OPTIONS",
        headers: {
          origin: "https://zakki.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );

    expect(res.headers.get("access-control-allow-origin")).toBe("https://zakki.test");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
  });

  test("別オリジンには許可ヘッダを返さない（パスキーの前段を他サイトから叩かせない）", async () => {
    const res = await makeApp().fetch(
      new Request("http://control.test/auth/login/options", {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.test",
          "access-control-request-method": "POST",
        },
      }),
    );

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("Cookie は使わないので credentials は許可しない", async () => {
    const res = await makeApp().fetch(
      new Request("http://control.test/healthz", { headers: { origin: "https://zakki.test" } }),
    );

    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
