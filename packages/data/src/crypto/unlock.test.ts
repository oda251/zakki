import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import { entries } from "@zakki/data/db/schema.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { changePassphrase, listEnvelopeKinds, unlockWithPassphrase } from "./envelopes.ts";
import type { UnlockPrompts } from "./unlock.ts";
import { unlockOrSetup } from "./unlock.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
});

const keyfileKek = () => sodium.randombytes_buf(32);

/** テスト用の決定的プロンプト。表示したリカバリコードを控える。 */
function fakePrompts(passphrase: string): UnlockPrompts & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    newPassphrase: () => Promise.resolve(passphrase),
    passphrase: () => Promise.resolve(passphrase),
    showRecoveryCode: (code) => {
      shown.push(code);
      return Promise.resolve();
    },
  };
}

describe("unlockOrSetup 初回（封筒なし）", () => {
  test("keyfile/passphrase/recovery を作り、コードを表示し、使えるctxを返す", async () => {
    const prompts = fakePrompts("ひみつのパス");
    const ctx = await unlockOrSetup(db, keyfileKek(), prompts);

    expect(getCrypto(db)).toBe(ctx);
    expect((await listEnvelopeKinds(db)).toSorted()).toEqual(["keyfile", "passphrase", "recovery"]);
    expect(prompts.shown.length).toBe(1);
    expect(prompts.shown[0]).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){7}$/);

    // ラウンドトリップ
    const ct = ctx.encString("やあ", "entry.raw");
    expect(ctx.decString(ct, "entry.raw")).toBe("やあ");
  });
});

describe("unlockOrSetup 再起動（封筒あり）", () => {
  test("キーファイルで無言アンロック（プロンプト未使用）", async () => {
    const kek = keyfileKek();
    await unlockOrSetup(db, kek, fakePrompts("p1"));

    // 同じ keyfile KEK で再アンロック → passphrase プロンプトは呼ばれない
    let passphraseCalled = false;
    const prompts: UnlockPrompts = {
      newPassphrase: () => Promise.reject(new Error("新規は呼ばれないはず")),
      passphrase: () => {
        passphraseCalled = true;
        return Promise.resolve("p1");
      },
      showRecoveryCode: () => Promise.resolve(),
    };
    const ctx = await unlockOrSetup(db, kek, prompts);
    expect(passphraseCalled).toBe(false);
    expect(getCrypto(db)).toBe(ctx);
  });

  test("キーファイルが使えない → パスフレーズプロンプトでアンロック", async () => {
    await unlockOrSetup(db, keyfileKek(), fakePrompts("正パス"));

    // 別デバイス相当: keyfile KEK が一致しない → passphrase へフォールバック
    let passphraseCalled = false;
    const prompts: UnlockPrompts = {
      newPassphrase: () => Promise.reject(new Error("呼ばれないはず")),
      passphrase: () => {
        passphraseCalled = true;
        return Promise.resolve("正パス");
      },
      showRecoveryCode: () => Promise.resolve(),
    };
    const ctx = await unlockOrSetup(db, keyfileKek(), prompts);
    expect(passphraseCalled).toBe(true);
    expect(getCrypto(db)).toBeDefined();
    expect(ctx.decString(ctx.encString("x", "entry.raw"), "entry.raw")).toBe("x");
  });

  test("パスフレーズ違いは throw し、呼び出し側で再試行できる", async () => {
    await unlockOrSetup(db, keyfileKek(), fakePrompts("正パス"));

    const prompts: UnlockPrompts = {
      newPassphrase: () => Promise.reject(new Error("呼ばれないはず")),
      passphrase: () => Promise.resolve("誤パス"),
      showRecoveryCode: () => Promise.resolve(),
    };
    let threw = false;
    try {
      await unlockOrSetup(db, keyfileKek(), prompts);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("changePassphrase はデータを再暗号化しない", () => {
  test("既存暗号文の at-rest バイトが変更後も不変", async () => {
    // 初回セットアップで暗号 ON にし、エントリを 1 件書く
    await unlockOrSetup(db, keyfileKek(), fakePrompts("old"));
    (
      await saveSnapshot(db, {
        date: "2026-06-21",
        raw: "kyou",
        converted: "きょう。",
        chunks: [{ content: "きょう。" }],
      })
    )._unsafeUnwrap();

    const [before] = await db.select({ raw: entries.raw }).from(entries);
    const dek = await unlockWithPassphrase(db, "old");

    await changePassphrase(db, dek, "newpass");

    // データ行の暗号文は 1 バイトも変わっていない（再暗号化なし）
    const [after] = await db.select({ raw: entries.raw }).from(entries);
    expect(after?.raw).toBe(before?.raw);

    // 旧パスは失効、新パスとリカバリは引き続き同一 DEK を開く
    let oldThrew = false;
    try {
      await unlockWithPassphrase(db, "old");
    } catch {
      oldThrew = true;
    }
    expect(oldThrew).toBe(true);
    const dekNew = await unlockWithPassphrase(db, "newpass");
    expect(dekNew.length).toBe(dek.length);
  });
});
