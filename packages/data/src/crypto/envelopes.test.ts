import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { generateDek, wrapDek } from "@zakki/core/crypto/dek.ts";
import { deriveKekFromPrf } from "@zakki/core/crypto/kdf.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { keyEnvelopes } from "@zakki/data/db/schema.ts";
import {
  addKeyfileEnvelope,
  addPasskeyEnvelope,
  addPassphraseEnvelope,
  addRecoveryEnvelope,
  changePassphrase,
  generateRecoveryCode,
  getPasskeyCredentialId,
  hasEnvelope,
  listEnvelopeKinds,
  putPasskeyEnvelope,
  unlockWithKeyfile,
  unlockWithPasskey,
  unlockWithPassphrase,
  unlockWithRecovery,
} from "./envelopes.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
});

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

describe("envelopes ラウンドトリップ", () => {
  test("keyfile: wrap → unlock で同一 DEK", async () => {
    const dek = generateDek();
    const kek = sodium.randombytes_buf(32);
    await addKeyfileEnvelope(db, dek, kek);
    expect(sameBytes(await unlockWithKeyfile(db, kek), dek)).toBe(true);
  });

  test("passphrase: addPassphrase → unlock で同一 DEK、誤りは throw", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "正しいパス");
    expect(sameBytes(await unlockWithPassphrase(db, "正しいパス"), dek)).toBe(true);

    let threw = false;
    try {
      await unlockWithPassphrase(db, "違うパス");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("passkey: addPasskey → unlock で同一 DEK、誤 PRF 出力は throw（issue #103）", async () => {
    const dek = generateDek();
    const prf = sodium.randombytes_buf(32);
    await addPasskeyEnvelope(db, dek, prf, "cred-abc");
    expect(sameBytes(await unlockWithPasskey(db, prf), dek)).toBe(true);
    expect(await getPasskeyCredentialId(db)).toBe("cred-abc");

    let threw = false;
    try {
      await unlockWithPasskey(db, sodium.randombytes_buf(32));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("passkey: putPasskeyEnvelope（wrap 済み）でも unlock できる・再登録は上書き（1 封筒）", async () => {
    const dek = generateDek();
    const prf = sodium.randombytes_buf(32);
    await putPasskeyEnvelope(db, wrapDek(dek, deriveKekFromPrf(prf)), "cred-1");
    expect(sameBytes(await unlockWithPasskey(db, prf), dek)).toBe(true);

    // kind 主キーにより上書き: 旧 PRF は失効し、新 PRF と新 credentialId が有効
    const prf2 = sodium.randombytes_buf(32);
    await addPasskeyEnvelope(db, dek, prf2, "cred-2");
    expect(await getPasskeyCredentialId(db)).toBe("cred-2");
    expect(sameBytes(await unlockWithPasskey(db, prf2), dek)).toBe(true);
    let oldThrew = false;
    try {
      await unlockWithPasskey(db, prf);
    } catch {
      oldThrew = true;
    }
    expect(oldThrew).toBe(true);
  });

  test("passkey: 封筒なしの unlock / credentialId は not found / null", async () => {
    expect(await getPasskeyCredentialId(db)).toBeNull();
    let threw = false;
    try {
      await unlockWithPasskey(db, sodium.randombytes_buf(32));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("recovery: addRecovery → unlock で同一 DEK、誤りは throw", async () => {
    const dek = generateDek();
    const code = generateRecoveryCode();
    await addRecoveryEnvelope(db, dek, code);
    expect(sameBytes(await unlockWithRecovery(db, code), dek)).toBe(true);

    let threw = false;
    try {
      await unlockWithRecovery(db, "WRONG-CODE-HERE");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("multi-envelope", () => {
  test("keyfile/passphrase/recovery/passkey が同一 DEK を開く", async () => {
    const dek = generateDek();
    const kek = sodium.randombytes_buf(32);
    const code = generateRecoveryCode();
    const prf = sodium.randombytes_buf(32);
    await addKeyfileEnvelope(db, dek, kek);
    await addPassphraseEnvelope(db, dek, "pass");
    await addRecoveryEnvelope(db, dek, code);
    await addPasskeyEnvelope(db, dek, prf, "cred-multi");

    const fromKeyfile = await unlockWithKeyfile(db, kek);
    const fromPass = await unlockWithPassphrase(db, "pass");
    const fromRecovery = await unlockWithRecovery(db, code);
    const fromPasskey = await unlockWithPasskey(db, prf);
    expect(sameBytes(fromKeyfile, dek)).toBe(true);
    expect(sameBytes(fromPass, dek)).toBe(true);
    expect(sameBytes(fromRecovery, dek)).toBe(true);
    expect(sameBytes(fromPasskey, dek)).toBe(true);
  });

  test("hasEnvelope / listEnvelopeKinds", async () => {
    const dek = generateDek();
    expect(await hasEnvelope(db, "passphrase")).toBe(false);
    expect(await listEnvelopeKinds(db)).toEqual([]);
    await addPassphraseEnvelope(db, dek, "p");
    await addRecoveryEnvelope(db, dek, generateRecoveryCode());
    expect(await hasEnvelope(db, "passphrase")).toBe(true);
    expect(await hasEnvelope(db, "keyfile")).toBe(false);
    expect((await listEnvelopeKinds(db)).toSorted()).toEqual(["passphrase", "recovery"]);
  });
});

describe("changePassphrase", () => {
  test("旧パス失効・新パス有効・リカバリ温存、封筒バイトの変化", async () => {
    const dek = generateDek();
    const code = generateRecoveryCode();
    await addPassphraseEnvelope(db, dek, "old");
    await addRecoveryEnvelope(db, dek, code);

    const [before] = await db
      .select()
      .from(keyEnvelopes)
      .where(eq(keyEnvelopes.kind, "passphrase"));

    await changePassphrase(db, dek, "new");

    // 旧パスは失敗、新パスは成功
    let oldThrew = false;
    try {
      await unlockWithPassphrase(db, "old");
    } catch {
      oldThrew = true;
    }
    expect(oldThrew).toBe(true);
    expect(sameBytes(await unlockWithPassphrase(db, "new"), dek)).toBe(true);

    // リカバリは引き続き同一 DEK を開ける
    expect(sameBytes(await unlockWithRecovery(db, code), dek)).toBe(true);

    // passphrase 封筒は新ソルト＋再 wrap で別バイトになっている
    const [after] = await db.select().from(keyEnvelopes).where(eq(keyEnvelopes.kind, "passphrase"));
    expect(before?.kdfSalt?.equals(after?.kdfSalt ?? Buffer.alloc(0))).toBe(false);
    expect(before?.wrappedDek.equals(after?.wrappedDek ?? Buffer.alloc(0))).toBe(false);
  });
});

describe("generateRecoveryCode", () => {
  test("形式（8x4 dash, 32 文字 + 7 ダッシュ）とランダム性", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){7}$/);
    expect(code.replace(/-/g, "").length).toBe(32);

    const codes = new Set(Array.from({ length: 64 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(64); // 160bit エントロピーなので衝突しない
  });
});
