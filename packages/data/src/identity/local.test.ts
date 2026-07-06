import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalIdentity } from "./local.ts";

// 設定ファイルを置かない一時ディレクトリを configHome として渡す（既定の ~/.config を踏まない）
let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "zakki-cfg-"));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
});

/** 一時 configHome に zakki/identity.json を書く */
function writeConfig(contents: string): void {
  const dir = join(configHome, "zakki");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), contents);
}

describe("resolveLocalIdentity", () => {
  test("env も設定ファイルも無ければローカル専用（userId=local・creds なし）", () => {
    const id = resolveLocalIdentity({}, configHome);
    expect(id.userId).toBe("local");
    expect(id.tursoUrl).toBeUndefined();
    expect(id.tursoToken).toBeUndefined();
  });

  test("env（検証済み config の上書き値）から creds と userId を拾う", () => {
    const id = resolveLocalIdentity(
      { userId: "alice", tursoUrl: "libsql://x.turso.io", tursoToken: "tok" },
      configHome,
    );
    expect(id.userId).toBe("alice");
    expect(id.tursoUrl).toBe("libsql://x.turso.io");
    expect(id.tursoToken).toBe("tok");
  });

  test("設定ファイルから読む", () => {
    writeConfig(
      JSON.stringify({ userId: "bob", tursoUrl: "libsql://y.turso.io", tursoToken: "ftok" }),
    );
    const id = resolveLocalIdentity({}, configHome);
    expect(id.userId).toBe("bob");
    expect(id.tursoUrl).toBe("libsql://y.turso.io");
    expect(id.tursoToken).toBe("ftok");
  });

  test("env が設定ファイルより優先される", () => {
    writeConfig(JSON.stringify({ userId: "file", tursoUrl: "libsql://file.turso.io" }));
    const id = resolveLocalIdentity(
      { userId: "env", tursoUrl: "libsql://env.turso.io" },
      configHome,
    );
    expect(id.userId).toBe("env");
    expect(id.tursoUrl).toBe("libsql://env.turso.io");
  });

  test("壊れた設定ファイルでも throw せず既定へフォールバック", () => {
    writeConfig("{ this is not json");
    const id = resolveLocalIdentity({}, configHome);
    expect(id.userId).toBe("local");
    expect(id.tursoUrl).toBeUndefined();
  });

  test("フィールド型違いの設定ファイルは検出して無視する（as キャストで通さない）", () => {
    writeConfig(JSON.stringify({ userId: 42, tursoUrl: ["libsql://x.turso.io"], tursoToken: 1 }));
    const id = resolveLocalIdentity({}, configHome);
    expect(id.userId).toBe("local");
    expect(id.tursoUrl).toBeUndefined();
    expect(id.tursoToken).toBeUndefined();
  });

  test("配列など object 以外の JSON も無視する", () => {
    writeConfig(JSON.stringify(["not", "an", "object"]));
    const id = resolveLocalIdentity({}, configHome);
    expect(id.userId).toBe("local");
  });
});
