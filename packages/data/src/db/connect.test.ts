import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "@zakki/core/identity/types.ts";
import { getOrCreateEntry } from "@zakki/data/entry/repository.ts";
import { openDb } from "./connect.ts";

let dbPath: string;

beforeEach(() => {
  // :memory: はコネクション毎に独立するため、replica パスを共有できる一時ファイルを使う
  dbPath = join(mkdtempSync(join(tmpdir(), "zakki-connect-")), "db.sqlite");
});

describe("openDb (local-only)", () => {
  const local: Identity = { userId: "local" };

  test("開いてマイグレーション済み・基本クエリが通る", async () => {
    const { db } = await openDb(local, dbPath);
    const entry = (await getOrCreateEntry(db, "2026-06-12"))._unsafeUnwrap();
    expect(entry.raw).toBe("");
  });

  test("sync() は no-op の Ok を返す（同期先が無い）", async () => {
    const { sync } = await openDb(local, dbPath);
    const r = await sync();
    expect(r.isOk()).toBe(true);
  });
});

// embedded replica の経路はオフラインで検証できない（Turso 不在のため SKIP）。
// libSQL は syncUrl を渡すと migrate の PRAGMA/execute 時点で書き込みをリモート
// プライマリへ委譲する（WriteDelegation）ため、ネットワーク無しでは openDb 自体が失敗する。
// openDb が sync() を呼ばない（構築時にネットワーク I/O を伴わない）という設計上の保証は
// connect.ts のコードで担保しており、実機（Turso 接続あり）での sync() 成功・
// device A→B 同期はここでは検証できない。
describe.skip("openDb (embedded replica)", () => {
  test("creds があれば embedded replica を開き、sync() でリモートと往復する", async () => {
    const id: Identity = {
      userId: "u1",
      tursoUrl: "libsql://fake.turso.io",
      tursoToken: "fake-token",
    };
    const handle = await openDb(id, dbPath);
    expect(handle.db).toBeDefined();
    const entry = (await getOrCreateEntry(handle.db, "2026-06-12"))._unsafeUnwrap();
    expect(entry.raw).toBe("");
  });
});
