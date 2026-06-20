import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyfilePath, loadOrCreateKeyfile } from "./keyfile.ts";

let tmp: string;
let prevConfig: string | undefined;

beforeEach(() => {
  prevConfig = process.env["XDG_CONFIG_HOME"];
  tmp = mkdtempSync(join(tmpdir(), "zakki-keyfile-"));
  process.env["XDG_CONFIG_HOME"] = tmp;
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevConfig;
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadOrCreateKeyfile", () => {
  test("無ければ 32 バイトを 0600 で作成する", async () => {
    const kek = await loadOrCreateKeyfile();
    expect(kek.length).toBe(32);
    const mode = statSync(keyfilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("再呼び出しで同じ KEK を返す（生成は初回のみ）", async () => {
    const first = await loadOrCreateKeyfile();
    const second = await loadOrCreateKeyfile();
    expect([...second]).toEqual([...first]);
  });
});
