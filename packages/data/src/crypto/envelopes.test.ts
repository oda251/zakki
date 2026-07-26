import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
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
  deletePasskeyEnvelope,
  generateRecoveryCode,
  hasEnvelope,
  listEnvelopeKinds,
  listPasskeyCredentialIds,
  putPasskeyEnvelope,
  putPasskeyEnvelopeIfProvisioned,
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
    expect(sameBytes(await unlockWithPasskey(db, prf, "cred-abc"), dek)).toBe(true);
    expect(await listPasskeyCredentialIds(db)).toEqual(["cred-abc"]);

    let threw = false;
    try {
      await unlockWithPasskey(db, sodium.randombytes_buf(32), "cred-abc");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("passkey: putPasskeyEnvelope（wrap 済み）でも unlock できる・同じ credential は上書き", async () => {
    const dek = generateDek();
    const prf = sodium.randombytes_buf(32);
    await putPasskeyEnvelope(db, wrapDek(dek, deriveKekFromPrf(prf)), "cred-1");
    expect(sameBytes(await unlockWithPasskey(db, prf, "cred-1"), dek)).toBe(true);

    // 同じ credentialId での再登録は再 wrap の上書き（旧 PRF は失効し封筒は 1 本のまま）
    const rewrapped = sodium.randombytes_buf(32);
    await addPasskeyEnvelope(db, dek, rewrapped, "cred-1");
    expect(await listPasskeyCredentialIds(db)).toEqual(["cred-1"]);
    expect(sameBytes(await unlockWithPasskey(db, rewrapped, "cred-1"), dek)).toBe(true);
    let oldThrew = false;
    try {
      await unlockWithPasskey(db, prf, "cred-1");
    } catch {
      oldThrew = true;
    }
    expect(oldThrew).toBe(true);
  });

  test("passkey: 封筒なしの unlock / credentialId 一覧は not found / 空配列", async () => {
    expect(await listPasskeyCredentialIds(db)).toEqual([]);
    let threw = false;
    try {
      await unlockWithPasskey(db, sodium.randombytes_buf(32), "cred-none");
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

/**
 * issue #120: パスキーはクレデンシャル（鍵ペア）ごとに PRF 出力が違うので、封筒も
 * クレデンシャルごとに持つ。schema の部分ユニークインデックス
 * （`UNIQUE (credential_id) WHERE kind='passkey'` / `UNIQUE (kind) WHERE kind<>'passkey'`）
 * が「passkey は複数・他は単数」を保証していることまで含めて確かめる。
 */
describe("複数 passkey 封筒（issue #120）", () => {
  test("2 本登録 → どちらの PRF 単独でも同じ DEK が開く", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "pass");
    const phone = sodium.randombytes_buf(32);
    const laptop = sodium.randombytes_buf(32);
    await addPasskeyEnvelope(db, dek, phone, "cred-phone");
    await addPasskeyEnvelope(db, dek, laptop, "cred-laptop");

    expect((await listPasskeyCredentialIds(db)).toSorted()).toEqual(["cred-laptop", "cred-phone"]);
    expect(sameBytes(await unlockWithPasskey(db, phone, "cred-phone"), dek)).toBe(true);
    expect(sameBytes(await unlockWithPasskey(db, laptop, "cred-laptop"), dek)).toBe(true);
    // 封筒の取り違え（別クレデンシャルの PRF）は AEAD 認証で失敗する
    let crossThrew = false;
    try {
      await unlockWithPasskey(db, phone, "cred-laptop");
    } catch {
      crossThrew = true;
    }
    expect(crossThrew).toBe(true);
  });

  test("1 本を失効（封筒削除）してももう 1 本で開ける・削除は冪等", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "pass");
    const phone = sodium.randombytes_buf(32);
    const laptop = sodium.randombytes_buf(32);
    await addPasskeyEnvelope(db, dek, phone, "cred-phone");
    await addPasskeyEnvelope(db, dek, laptop, "cred-laptop");

    expect(await deletePasskeyEnvelope(db, "cred-phone")).toBe(true);
    expect(await listPasskeyCredentialIds(db)).toEqual(["cred-laptop"]);
    expect(sameBytes(await unlockWithPasskey(db, laptop, "cred-laptop"), dek)).toBe(true);
    // 失効した側は封筒ごと消えているので開く経路が無い
    let revokedThrew = false;
    try {
      await unlockWithPasskey(db, phone, "cred-phone");
    } catch {
      revokedThrew = true;
    }
    expect(revokedThrew).toBe(true);
    // 2 度目の削除（コントロールプレーン側だけ先に消えていた等）は false で例外なし
    expect(await deletePasskeyEnvelope(db, "cred-phone")).toBe(false);
    // 単数 kind の封筒は passkey の失効に巻き込まれない
    expect(sameBytes(await unlockWithPassphrase(db, "pass"), dek)).toBe(true);
  });

  test("passkey 以外は kind ごとに 1 本のまま（部分ユニークインデックス）", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "old");
    await addPassphraseEnvelope(db, dek, "new");
    await addPasskeyEnvelope(db, dek, sodium.randombytes_buf(32), "cred-a");
    await addPasskeyEnvelope(db, dek, sodium.randombytes_buf(32), "cred-b");

    const rows = await db.select().from(keyEnvelopes);
    expect(rows.filter((r) => r.kind === "passphrase")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "passkey")).toHaveLength(2);
    // 重複 kind は畳んで返す（呼び出し側は「手段があるか」だけを見る）
    expect((await listEnvelopeKinds(db)).toSorted()).toEqual(["passkey", "passphrase"]);
    expect(sameBytes(await unlockWithPassphrase(db, "new"), dek)).toBe(true);
  });

  test("CHECK 制約: credential_id は passkey 封筒だけが持つ（部分インデックスの実効化）", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "pass");
    const wrapped = Buffer.from(wrapDek(dek, deriveKekFromPrf(sodium.randombytes_buf(32))));
    const rejected = async (kind: string, credentialId: string | null): Promise<boolean> => {
      try {
        await db.run(sql`
          INSERT INTO key_envelopes ("kind", "wrapped_dek", "credential_id", "created_at")
          VALUES (${kind}, ${wrapped}, ${credentialId}, '2026-07-27T00:00:00.000Z')
        `);
        return false;
      } catch {
        return true;
      }
    };
    // credential_id 無しの passkey 封筒（SQLite の UNIQUE は NULL を別値扱いするので
    // これを許すと開けない封筒が無限に積める）
    expect(await rejected("passkey", null)).toBe(true);
    // passkey 以外が credential_id を持つのも不整合
    expect(await rejected("keyfile", "cred-keyfile")).toBe(true);
    expect(await listPasskeyCredentialIds(db)).toEqual([]);
  });

  test("putPasskeyEnvelopeIfProvisioned: 封筒ゼロは拒否、既存封筒があれば upsert（#103 の 409）", async () => {
    const dek = generateDek();
    const prf = sodium.randombytes_buf(32);
    const wrapped = wrapDek(dek, deriveKekFromPrf(prf));

    // 暗号未プロビジョン（封筒ゼロ）の DB には入れない
    expect(await putPasskeyEnvelopeIfProvisioned(db, wrapped, "cred-x")).toBe(false);
    expect(await listPasskeyCredentialIds(db)).toEqual([]);

    // 既存封筒（= DEK 確立済み）があれば入る。2 本目も入る
    await addPassphraseEnvelope(db, dek, "pass");
    expect(await putPasskeyEnvelopeIfProvisioned(db, wrapped, "cred-x")).toBe(true);
    const second = sodium.randombytes_buf(32);
    expect(
      await putPasskeyEnvelopeIfProvisioned(db, wrapDek(dek, deriveKekFromPrf(second)), "cred-y"),
    ).toBe(true);
    expect((await listPasskeyCredentialIds(db)).toSorted()).toEqual(["cred-x", "cred-y"]);
    expect(sameBytes(await unlockWithPasskey(db, prf, "cred-x"), dek)).toBe(true);
    expect(sameBytes(await unlockWithPasskey(db, second, "cred-y"), dek)).toBe(true);

    // 同じ credentialId は上書き（行は増えない）
    const rewrapped = sodium.randombytes_buf(32);
    expect(
      await putPasskeyEnvelopeIfProvisioned(
        db,
        wrapDek(dek, deriveKekFromPrf(rewrapped)),
        "cred-x",
      ),
    ).toBe(true);
    expect((await listPasskeyCredentialIds(db)).toSorted()).toEqual(["cred-x", "cred-y"]);
    expect(sameBytes(await unlockWithPasskey(db, rewrapped, "cred-x"), dek)).toBe(true);
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
    const fromPasskey = await unlockWithPasskey(db, prf, "cred-multi");
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
