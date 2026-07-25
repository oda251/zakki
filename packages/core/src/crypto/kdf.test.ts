import { beforeAll, describe, expect, test } from "bun:test";
import { deriveKekFromPrf, deriveKey, generateSalt } from "./kdf.ts";
import { ready, sodium } from "./sodium.ts";

beforeAll(async () => {
  await ready();
});

describe("KDF (Argon2id)", () => {
  test("generateSalt は 16 バイトを返し、毎回異なる", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a.length).toBe(16);
    expect(a).not.toEqual(b);
  });

  test("同じパスフレーズ + 同じソルト → 同じ 32 バイト鍵", () => {
    const salt = generateSalt();
    const k1 = deriveKey("correct horse battery staple", salt);
    const k2 = deriveKey("correct horse battery staple", salt);
    expect(k1.length).toBe(32);
    expect(k1).toEqual(k2);
  });

  test("ソルトが違えば鍵も異なる", () => {
    const k1 = deriveKey("same passphrase", generateSalt());
    const k2 = deriveKey("same passphrase", generateSalt());
    expect(k1).not.toEqual(k2);
  });

  test("パスフレーズが違えば鍵も異なる（同一ソルト）", () => {
    const salt = generateSalt();
    expect(deriveKey("pass-a", salt)).not.toEqual(deriveKey("pass-b", salt));
  });
});

describe("deriveKekFromPrf (passkey PRF → KEK, issue #103)", () => {
  test("決定的: 同じ PRF 出力 → 同じ 32 バイト KEK", () => {
    const prf = sodium.randombytes_buf(32);
    const k1 = deriveKekFromPrf(prf);
    const k2 = deriveKekFromPrf(prf);
    expect(k1.length).toBe(32);
    expect(k1).toEqual(k2);
  });

  test("PRF 出力が違えば KEK も異なる", () => {
    expect(deriveKekFromPrf(sodium.randombytes_buf(32))).not.toEqual(
      deriveKekFromPrf(sodium.randombytes_buf(32)),
    );
  });

  test("domain separation: KEK は PRF 出力そのもの・素の BLAKE2b と一致しない", () => {
    const prf = sodium.randombytes_buf(32);
    const kek = deriveKekFromPrf(prf);
    expect(kek).not.toEqual(prf);
    // 鍵なし（コンテキストなし）の generichash とは別値になる
    expect(kek).not.toEqual(sodium.crypto_generichash(32, prf, null));
  });

  test("32 バイト以外の入力は throw する", () => {
    expect(() => deriveKekFromPrf(new Uint8Array(31))).toThrow();
    expect(() => deriveKekFromPrf(new Uint8Array(33))).toThrow();
    expect(() => deriveKekFromPrf(new Uint8Array(0))).toThrow();
  });
});
