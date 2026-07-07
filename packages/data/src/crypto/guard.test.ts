import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import { assertCryptoReady } from "./guard.ts";
import { initCrypto } from "./init.ts";

let dbPath: string;

beforeAll(async () => {
  await ready();
});

beforeEach(() => {
  // WeakMap の CryptoContext はハンドル単位。同一ファイルを別ハンドルで
  // 開き直して「アンロックなしの再オープン」を再現するため、一時ファイルを使う
  dbPath = join(mkdtempSync(join(tmpdir(), "zakki-guard-")), "db.sqlite");
});

const kek = () => sodium.randombytes_buf(32);

describe("assertCryptoReady", () => {
  test("暗号 ON で作成した DB をコンテキスト未登録で開くと拒否される", async () => {
    // 暗号 ON で初期化（key_envelopes に封筒を作る）
    const db1 = await createDb(dbPath);
    await initCrypto(db1, kek());

    // 別ハンドルで再オープン（ZAKKI_ENCRYPTION 未設定の起動に相当。アンロックなし）
    const db2 = await createDb(dbPath);
    expect(getCrypto(db2)).toBeUndefined();
    let message = "";
    try {
      await assertCryptoReady(db2);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("ZAKKI_ENCRYPTION=1");
  });

  test("アンロック済み（コンテキスト登録済み）なら通る", async () => {
    const db = await createDb(dbPath);
    await initCrypto(db, kek());
    expect(getCrypto(db)).toBeDefined();
    await assertCryptoReady(db); // throw しないこと
  });

  test("暗号 OFF の DB（封筒なし）は影響を受けない", async () => {
    const db = await createDb(dbPath);
    expect(getCrypto(db)).toBeUndefined();
    await assertCryptoReady(db); // 平文運用は従来どおり throw しないこと
  });
});
