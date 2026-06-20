import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalIdentity } from "./local.ts";

// テスト間で ZAKKI_* / XDG_CONFIG_HOME を漏らさないよう保存・復元する
const ENV_KEYS = ["ZAKKI_TURSO_URL", "ZAKKI_TURSO_TOKEN", "ZAKKI_USER_ID", "XDG_CONFIG_HOME"];
let saved: Record<string, string | undefined>;
let configHome: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // 設定ファイルを置かない一時 XDG_CONFIG_HOME（既定の ~/.config を踏まない）
  configHome = mkdtempSync(join(tmpdir(), "zakki-cfg-"));
  process.env["XDG_CONFIG_HOME"] = configHome;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
  rmSync(configHome, { recursive: true, force: true });
});

/** 一時 XDG_CONFIG_HOME に zakki/identity.json を書く */
function writeConfig(contents: string): void {
  const dir = join(configHome, "zakki");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), contents);
}

describe("resolveLocalIdentity", () => {
  test("env も設定ファイルも無ければローカル専用（userId=local・creds なし）", () => {
    const id = resolveLocalIdentity();
    expect(id.userId).toBe("local");
    expect(id.tursoUrl).toBeUndefined();
    expect(id.tursoToken).toBeUndefined();
  });

  test("env から creds と userId を拾う", () => {
    process.env["ZAKKI_TURSO_URL"] = "libsql://x.turso.io";
    process.env["ZAKKI_TURSO_TOKEN"] = "tok";
    process.env["ZAKKI_USER_ID"] = "alice";
    const id = resolveLocalIdentity();
    expect(id.userId).toBe("alice");
    expect(id.tursoUrl).toBe("libsql://x.turso.io");
    expect(id.tursoToken).toBe("tok");
  });

  test("設定ファイルから読む", () => {
    writeConfig(
      JSON.stringify({ userId: "bob", tursoUrl: "libsql://y.turso.io", tursoToken: "ftok" }),
    );
    const id = resolveLocalIdentity();
    expect(id.userId).toBe("bob");
    expect(id.tursoUrl).toBe("libsql://y.turso.io");
    expect(id.tursoToken).toBe("ftok");
  });

  test("env が設定ファイルより優先される", () => {
    writeConfig(JSON.stringify({ userId: "file", tursoUrl: "libsql://file.turso.io" }));
    process.env["ZAKKI_USER_ID"] = "env";
    process.env["ZAKKI_TURSO_URL"] = "libsql://env.turso.io";
    const id = resolveLocalIdentity();
    expect(id.userId).toBe("env");
    expect(id.tursoUrl).toBe("libsql://env.turso.io");
  });

  test("壊れた設定ファイルでも throw せず既定へフォールバック", () => {
    writeConfig("{ this is not json");
    const id = resolveLocalIdentity();
    expect(id.userId).toBe("local");
    expect(id.tursoUrl).toBeUndefined();
  });
});
