import { beforeAll, describe, expect, test } from "bun:test";
import { decrypt, encrypt } from "./aead.ts";
import { ready } from "./sodium.ts";

const enc = new TextEncoder();

let key: Uint8Array;
let otherKey: Uint8Array;

beforeAll(async () => {
  const s = await ready();
  key = s.crypto_aead_xchacha20poly1305_ietf_keygen();
  otherKey = s.crypto_aead_xchacha20poly1305_ietf_keygen();
});

describe("AEAD XChaCha20-Poly1305", () => {
  test("encrypt → decrypt で元の平文に戻る", () => {
    const pt = enc.encode("秘密のメッセージ");
    const blob = encrypt(key, pt);
    expect(decrypt(key, blob)).toEqual(pt);
  });

  test("aad を束縛して往復できる / aad 不一致は失敗する", () => {
    const pt = enc.encode("payload");
    const ad = enc.encode("chunk.content");
    const blob = encrypt(key, pt, ad);
    expect(decrypt(key, blob, ad)).toEqual(pt);
    expect(() => decrypt(key, blob, enc.encode("chunk.other"))).toThrow();
    expect(() => decrypt(key, blob)).toThrow();
  });

  test("鍵違いは復号に失敗する", () => {
    const blob = encrypt(key, enc.encode("data"));
    expect(() => decrypt(otherKey, blob)).toThrow();
  });

  test("暗号文を 1 バイト改竄すると復号に失敗する", () => {
    const blob = encrypt(key, enc.encode("tamper me"));
    const tampered = Uint8Array.from(blob);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    expect(() => decrypt(key, tampered)).toThrow();
  });

  test("同一入力でも nonce がランダムなので暗号文は毎回異なる", () => {
    const pt = enc.encode("same input");
    const a = encrypt(key, pt);
    const b = encrypt(key, pt);
    expect(a).not.toEqual(b);
    // 双方とも復号は成功する
    expect(decrypt(key, a)).toEqual(pt);
    expect(decrypt(key, b)).toEqual(pt);
  });

  test("nonce 長未満の blob は失敗する", () => {
    expect(() => decrypt(key, new Uint8Array(5))).toThrow();
  });
});
