import { describe, expect, test } from "bun:test";
import handler from "./index.ts";

/**
 * Workers エントリの検証（issue #99）。env は fetch の第2引数で受け取り、
 * 不正なら起動失敗（明示 throw）— リクエスト処理中の 500 とは区別する。
 * 有効 env では @libsql/client/web のクライアント生成のみ（/healthz は DB に
 * 触れない）ため、ネットワークなしで検証できる。
 */

const validEnv = {
  CONTROL_DB_URL: "libsql://control.example.turso.io",
  CONTROL_DB_TOKEN: "control-token",
  SESSION_SECRET: "session-secret",
  TURSO_API_TOKEN: "turso-api-token",
  TURSO_ORG: "example-org",
  TURSO_GROUP: "default",
  RP_ID: "zakki.example.com",
  RP_ORIGIN: "https://zakki.example.com",
};

describe("Workers エントリ", () => {
  test("有効な env なら /healthz が 200", async () => {
    const res = await handler.fetch(new Request("http://control.test/healthz"), validEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("env 不正は変数名を含む明示エラーで起動失敗（500 を返さない）", () => {
    expect(() => handler.fetch(new Request("http://control.test/healthz"), {})).toThrow(
      /CONTROL_DB_URL/,
    );
  });
});
