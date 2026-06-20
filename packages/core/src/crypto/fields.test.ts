import { beforeAll, describe, expect, test } from "bun:test";
import {
  aad,
  decryptString,
  decryptVector,
  encryptString,
  encryptVector,
  fingerprint,
} from "./fields.ts";
import { ready } from "./sodium.ts";

let key: Uint8Array;
let otherKey: Uint8Array;

beforeAll(async () => {
  const s = await ready();
  key = s.crypto_aead_xchacha20poly1305_ietf_keygen();
  otherKey = s.crypto_aead_xchacha20poly1305_ietf_keygen();
});

describe("field helpers: string", () => {
  test("encryptString → decryptString 往復（ASCII / 日本語 / 絵文字）", () => {
    for (const s of ["hello", "今日はコードを書いた。", "emoji 🦀🔐", ""]) {
      const b64 = encryptString(key, s);
      expect(b64).not.toBe(s);
      expect(decryptString(key, b64)).toBe(s);
    }
  });

  test("aad でフィールドに束縛できる", () => {
    const ad = aad("chunk.content");
    const b64 = encryptString(key, "本文", ad);
    expect(decryptString(key, b64, ad)).toBe("本文");
    expect(() => decryptString(key, b64, aad("chunk.title"))).toThrow();
  });

  test("鍵違いでは復号に失敗する", () => {
    const b64 = encryptString(key, "secret");
    expect(() => decryptString(otherKey, b64)).toThrow();
  });
});

describe("field helpers: vector", () => {
  test("encryptVector → decryptVector で Float32 値が保たれる", () => {
    const v = new Float32Array([0.5, -1.25, 3.0, 0, 1e-7, -2.5e3]);
    const blob = encryptVector(key, v);
    const back = decryptVector(key, blob);
    expect(back.length).toBe(v.length);
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  test("より大きなバッファのスライス（byteOffset あり）でも正しく扱える", () => {
    const big = new Float32Array([9, 9, 0.5, -1.25, 3.0, 9]);
    const view = big.subarray(2, 5); // [0.5, -1.25, 3.0]
    const back = decryptVector(key, encryptVector(key, view));
    expect(Array.from(back)).toEqual([0.5, -1.25, 3.0]);
  });
});

describe("field helpers: fingerprint", () => {
  test("決定的: 同じ入力 → 同じフィンガープリント", () => {
    expect(fingerprint(key, "日記")).toBe(fingerprint(key, "日記"));
  });

  test("入力が違えばフィンガープリントも違う", () => {
    expect(fingerprint(key, "tag-a")).not.toBe(fingerprint(key, "tag-b"));
  });

  test("鍵に依存する: 鍵が違えば同じ入力でも異なる", () => {
    expect(fingerprint(key, "日記")).not.toBe(fingerprint(otherKey, "日記"));
  });
});
