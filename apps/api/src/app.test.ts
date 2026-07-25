import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@zakki/api/db/schema.ts";
import { createApp } from "./app.ts";

/**
 * fetch ハンドラ直叩きの検証（issue #99）。DB は本物の libsql（in-memory）を
 * 注入する（~/.references/policy/testing.md: ローカルで再現できる依存は本物）。
 */

function makeApp() {
  const db = drizzle(createClient({ url: ":memory:" }), { schema });
  return createApp({ db });
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
