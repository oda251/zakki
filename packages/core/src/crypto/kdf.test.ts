import { beforeAll, describe, expect, test } from "bun:test";
import { deriveKey, generateSalt } from "./kdf.ts";
import { ready } from "./sodium.ts";

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
