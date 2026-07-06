import { describe, expect, test } from "bun:test";
import { parseZakkiConfig } from "./env.ts";

describe("parseZakkiConfig", () => {
  test("空 env で既定値（webPort=3777・フラグ false・他は undefined）", () => {
    const config = parseZakkiConfig({})._unsafeUnwrap();
    expect(config.webPort).toBe(3777);
    expect(config.encryption).toBe(false);
    expect(config.noEmbedding).toBe(false);
    expect(config.userId).toBeUndefined();
    expect(config.tursoUrl).toBeUndefined();
    expect(config.llmBaseUrl).toBeUndefined();
    expect(config.ancoPath).toBeUndefined();
    expect(config.vaultDir).toBeUndefined();
    expect(config.xdgDataHome).toBeUndefined();
  });

  test("文字列値はそのまま camelCase フィールドへ写す", () => {
    const config = parseZakkiConfig({
      ZAKKI_USER_ID: "alice",
      ZAKKI_TURSO_URL: "libsql://x.turso.io",
      ZAKKI_TURSO_TOKEN: "tok",
      ZAKKI_LLM_BASE_URL: "http://127.0.0.1:1234/v1",
      ZAKKI_LLM_MODEL: "qwen3-4b",
      ZAKKI_ANCO_PATH: "/opt/anco",
      ZAKKI_ZENZ_PATH: "/opt/zenz.gguf",
      ZAKKI_VAULT_DIR: "/tmp/vault",
      XDG_DATA_HOME: "/tmp/data",
      XDG_CONFIG_HOME: "/tmp/config",
    })._unsafeUnwrap();
    expect(config.userId).toBe("alice");
    expect(config.tursoUrl).toBe("libsql://x.turso.io");
    expect(config.tursoToken).toBe("tok");
    expect(config.llmBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(config.llmModel).toBe("qwen3-4b");
    expect(config.ancoPath).toBe("/opt/anco");
    expect(config.zenzPath).toBe("/opt/zenz.gguf");
    expect(config.vaultDir).toBe("/tmp/vault");
    expect(config.xdgDataHome).toBe("/tmp/data");
    expect(config.xdgConfigHome).toBe("/tmp/config");
  });

  test('フラグは "1" のみ true（従来の判定を踏襲）', () => {
    expect(parseZakkiConfig({ ZAKKI_ENCRYPTION: "1" })._unsafeUnwrap().encryption).toBe(true);
    expect(parseZakkiConfig({ ZAKKI_ENCRYPTION: "true" })._unsafeUnwrap().encryption).toBe(false);
    expect(parseZakkiConfig({ ZAKKI_ENCRYPTION: "0" })._unsafeUnwrap().encryption).toBe(false);
    expect(parseZakkiConfig({ ZAKKI_NO_EMBEDDING: "1" })._unsafeUnwrap().noEmbedding).toBe(true);
  });

  test("ZAKKI_WEB_PORT は数値へ変換する", () => {
    expect(parseZakkiConfig({ ZAKKI_WEB_PORT: "8080" })._unsafeUnwrap().webPort).toBe(8080);
  });

  test("ZAKKI_WEB_PORT=abc は変数名を含む検証エラー（NaN ポートで起動しない）", () => {
    const result = parseZakkiConfig({ ZAKKI_WEB_PORT: "abc" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain("ZAKKI_WEB_PORT");
  });

  test("ZAKKI_WEB_PORT の範囲外（0・65536）は検証エラー", () => {
    expect(parseZakkiConfig({ ZAKKI_WEB_PORT: "0" }).isErr()).toBe(true);
    expect(parseZakkiConfig({ ZAKKI_WEB_PORT: "65536" }).isErr()).toBe(true);
    expect(parseZakkiConfig({ ZAKKI_WEB_PORT: "65535" })._unsafeUnwrap().webPort).toBe(65535);
    expect(parseZakkiConfig({ ZAKKI_WEB_PORT: "1" })._unsafeUnwrap().webPort).toBe(1);
  });

  test("無関係な環境変数は無視する", () => {
    const config = parseZakkiConfig({ PATH: "/usr/bin", HOME: "/home/x" })._unsafeUnwrap();
    expect(config.webPort).toBe(3777);
  });
});
