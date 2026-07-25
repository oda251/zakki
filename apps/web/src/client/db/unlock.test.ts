import { beforeAll, describe, expect, test } from "bun:test";
import { wrapDek } from "@zakki/core/crypto/dek.ts";
import {
  defaultKdfParams,
  deriveKekFromPrf,
  deriveKey,
  generateSalt,
} from "@zakki/core/crypto/kdf.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import {
  fetchEnvelopes,
  openEnvelope,
  openPasskeyEnvelope,
  unlockWithPrompt,
} from "@zakki/web/client/db/unlock.ts";
import type { KdfCryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";

/**
 * issue #43: クライアント側アンロック（暫定）。封筒はサーバから取得し、
 * パスフレーズ → Argon2id → KEK → unwrapDek はすべてクライアントで行う。
 * 得た DEK はメモリのみで保持し、永続ストレージへは書かない。
 */
let dek: Uint8Array;
let envelope: KdfCryptoEnvelope;
const PASSPHRASE = "正しいパスフレーズ";

beforeAll(async () => {
  const s = await ready();
  dek = s.crypto_aead_xchacha20poly1305_ietf_keygen();
  const salt = generateSalt();
  const { opsLimit, memLimit } = defaultKdfParams();
  const kek = deriveKey(PASSPHRASE, salt, opsLimit, memLimit);
  envelope = {
    kind: "passphrase",
    wrappedDek: s.to_base64(wrapDek(dek, kek), s.base64_variants.ORIGINAL),
    kdfSalt: s.to_base64(salt, s.base64_variants.ORIGINAL),
    kdfOps: opsLimit,
    kdfMem: memLimit,
  };
});

describe("openEnvelope", () => {
  test("C1: 正しい secret → DEK 復元、誤り → throw（AEAD 認証失敗）", () => {
    expect(openEnvelope(envelope, PASSPHRASE)).toEqual(dek);
    expect(() => openEnvelope(envelope, "まちがい")).toThrow();
  });
});

describe("openPasskeyEnvelope (#103)", () => {
  test("C4: 正しい PRF 出力 → DEK 復元、誤り → throw（AEAD 認証失敗）", async () => {
    const s = await ready();
    const prf = s.randombytes_buf(32);
    const passkeyEnvelope = {
      kind: "passkey" as const,
      wrappedDek: s.to_base64(wrapDek(dek, deriveKekFromPrf(prf)), s.base64_variants.ORIGINAL),
      credentialId: "cred-client",
    };
    expect(openPasskeyEnvelope(passkeyEnvelope, prf)).toEqual(dek);
    expect(() => openPasskeyEnvelope(passkeyEnvelope, s.randombytes_buf(32))).toThrow();
    // 32 バイト以外の PRF 出力（PRF 未対応環境の値）は KEK 導出前に拒否される
    expect(() => openPasskeyEnvelope(passkeyEnvelope, s.randombytes_buf(16))).toThrow();
  });
});

describe("unlockWithPrompt", () => {
  test("C2: 誤り → 再試行 → 成功 の順で DEK を返す", async () => {
    const answers = ["まちがい", PASSPHRASE];
    const result = await unlockWithPrompt([envelope], () =>
      Promise.resolve(answers.shift() ?? null),
    );
    expect(result).toEqual(dek);
  });

  test("C2: キャンセル（null）→ null、封筒なし → null（prompt は呼ばれない）", async () => {
    expect(await unlockWithPrompt([envelope], () => Promise.resolve(null))).toBeNull();
    let asked = 0;
    expect(
      await unlockWithPrompt([], () => {
        asked += 1;
        return Promise.resolve(PASSPHRASE);
      }),
    ).toBeNull();
    expect(asked).toBe(0);
  });

  test("C2: 全試行が誤りなら null（無限ループしない）", async () => {
    expect(await unlockWithPrompt([envelope], () => Promise.resolve("まちがい"))).toBeNull();
  });
});

describe("fetchEnvelopes", () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  test("C3: レスポンスを valibot 検証して封筒配列を返す", async () => {
    const fetchFn = () => Promise.resolve(jsonResponse({ envelopes: [envelope] }));
    expect(await fetchEnvelopes(fetchFn)).toEqual([envelope]);
  });

  test("C3: 形が不正なレスポンスは throw する", async () => {
    const fetchFn = () => Promise.resolve(jsonResponse({ envelopes: [{ kind: "passphrase" }] }));
    expect(fetchEnvelopes(fetchFn)).rejects.toThrow();
  });

  test("C3: 非 2xx は throw する", async () => {
    const fetchFn = () => Promise.resolve(new Response("ng", { status: 500 }));
    expect(fetchEnvelopes(fetchFn)).rejects.toThrow();
  });
});
