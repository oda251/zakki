import { describe, expect, test } from "bun:test";
import { parseApiEnv } from "./env.ts";

/**
 * コントロールプレーンの env 検証（issue #99）。
 * Workers では env は fetch の第2引数で渡る（process.env は存在しない）ため、
 * 入力はプレーンなオブジェクトで受ける。
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

describe("parseApiEnv", () => {
  test("必須 8 変数が揃っていれば camelCase の設定に写す", () => {
    const config = parseApiEnv(validEnv)._unsafeUnwrap();
    expect(config).toEqual({
      controlDbUrl: "libsql://control.example.turso.io",
      controlDbToken: "control-token",
      sessionSecret: "session-secret",
      tursoApiToken: "turso-api-token",
      tursoOrg: "example-org",
      tursoGroup: "default",
      rpId: "zakki.example.com",
      rpOrigin: "https://zakki.example.com",
    });
  });

  test("欠けている変数があれば変数名を含むエラーで失敗する", () => {
    const { SESSION_SECRET: _omitted, ...rest } = validEnv;
    const result = parseApiEnv(rest);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain("SESSION_SECRET");
  });

  test("空文字列は不正（変数名を含むエラー）", () => {
    const result = parseApiEnv({ ...validEnv, RP_ID: "" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain("RP_ID");
  });

  test("未知のキー（Workers のバインディング等）は無視する", () => {
    const result = parseApiEnv({ ...validEnv, SOME_BINDING: { fetch: () => {} } });
    expect(result.isOk()).toBe(true);
  });
});
