import { beforeAll, describe, expect, test } from "bun:test";
import { generateDek, unwrapDek, wrapDek } from "./dek.ts";
import { ready } from "./sodium.ts";

let kek: Uint8Array;
let otherKek: Uint8Array;

beforeAll(async () => {
  const s = await ready();
  kek = s.crypto_aead_xchacha20poly1305_ietf_keygen();
  otherKek = s.crypto_aead_xchacha20poly1305_ietf_keygen();
});

describe("DEK envelope (wrap/unwrap)", () => {
  test("generateDek は 32 バイトを返し、毎回異なる", () => {
    const a = generateDek();
    const b = generateDek();
    expect(a.length).toBe(32);
    expect(a).not.toEqual(b);
  });

  test("wrap → unwrap で同じ DEK に戻る", () => {
    const dek = generateDek();
    const envelope = wrapDek(dek, kek);
    expect(unwrapDek(envelope, kek)).toEqual(dek);
  });

  test("KEK 違いでは unwrap に失敗する（パスフレーズ違い検出）", () => {
    const dek = generateDek();
    const envelope = wrapDek(dek, kek);
    expect(() => unwrapDek(envelope, otherKek)).toThrow();
  });

  test("1 つの DEK に複数の封筒を作れ、いずれからも同じ DEK を取り出せる", () => {
    const dek = generateDek();
    const env1 = wrapDek(dek, kek);
    const env2 = wrapDek(dek, otherKek);
    expect(env1).not.toEqual(env2);
    expect(unwrapDek(env1, kek)).toEqual(dek);
    expect(unwrapDek(env2, otherKek)).toEqual(dek);
  });
});
