import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import { initCrypto } from "./init.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
});

const kek = () => sodium.randombytes_buf(32);

describe("initCrypto", () => {
  test("新規 DB で crypto_meta を作り、使えるコンテキストを返す", async () => {
    const k = kek();
    const ctx = await initCrypto(db, k);
    expect(getCrypto(db)).toBe(ctx);

    const rows = await db.all(sql`SELECT id, version FROM crypto_meta`);
    expect(rows.length).toBe(1);

    // ラウンドトリップ
    const ct = ctx.encString("ひみつ", "entry.raw");
    expect(ct).not.toContain("ひみつ");
    expect(ctx.decString(ct, "entry.raw")).toBe("ひみつ");
  });

  test("同じ KEK での再初期化は同一 DEK を復元する", async () => {
    const k = kek();
    const ctx1 = await initCrypto(db, k);
    const ct = ctx1.encString("やあ", "entry.raw");

    // 別ハンドル相当（同一 DB ファイル）で再オープン → 同じ envelope を unwrap
    const ctx2 = await initCrypto(db, k);
    expect(ctx2.decString(ct, "entry.raw")).toBe("やあ");
  });

  test("誤った KEK では unwrap に失敗して throw する", async () => {
    await initCrypto(db, kek());
    let threw = false;
    try {
      await initCrypto(db, kek());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
