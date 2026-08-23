import { beforeAll, describe, expect, test } from "bun:test";
import { DEK_BYTES } from "@zakki/core/crypto/dek.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { fromBase64, toBase64, WRAPPED_DEK_BYTES } from "@zakki/core/crypto/wire.ts";

/**
 * sodium を使わない wire ヘルパ（issue #134）。
 *
 * 検証の要点は「**sodium と同じ結果になること**」。中継サーバはこちらを使い、
 * クライアント・TUI は sodium を使うので、食い違うと封筒が開けなくなる。
 * sodium との突き合わせは bun（sodium が動く環境）でしかできないため、ここで縛る。
 */

beforeAll(async () => {
  await ready();
});

describe("toBase64 / fromBase64", () => {
  test("sodium の ORIGINAL 変種と同じ文字列になる", () => {
    for (const len of [0, 1, 2, 3, 32, 72, 255]) {
      const bytes = sodium.randombytes_buf(len);
      expect(toBase64(bytes)).toBe(sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL));
    }
  });

  test("sodium が作った base64 を復号できる（往復も一致）", () => {
    const bytes = sodium.randombytes_buf(WRAPPED_DEK_BYTES);
    const encoded = sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

    expect([...fromBase64(encoded)]).toEqual([...bytes]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  test("全バイト値を通しても壊れない", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...fromBase64(toBase64(all))]).toEqual([...all]);
  });

  test("形が違えば投げる（緩く受けて開けない封筒を保存しない）", () => {
    // base64url（- _）・パディング欠け・空白・非 base64 文字はすべて拒む
    for (const bad of ["ab-_", "abc", "a b=", "!!!!", "====="]) {
      expect(() => fromBase64(bad)).toThrow();
    }
  });
});

describe("WRAPPED_DEK_BYTES", () => {
  test("sodium の定数から計算した値と一致する", () => {
    expect(WRAPPED_DEK_BYTES).toBe(
      sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES +
        DEK_BYTES +
        sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES,
    );
  });
});
