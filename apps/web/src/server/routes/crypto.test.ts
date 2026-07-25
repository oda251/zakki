import { beforeEach, describe, expect, test } from "bun:test";
import { generateDek, wrapDek } from "@zakki/core/crypto/dek.ts";
import { deriveKekFromPrf } from "@zakki/core/crypto/kdf.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import {
  addKeyfileEnvelope,
  addPasskeyEnvelope,
  addPassphraseEnvelope,
  getPasskeyCredentialId,
  unlockWithPasskey,
} from "@zakki/data/crypto/envelopes.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import { openEnvelope, openPasskeyEnvelope } from "@zakki/web/client/db/unlock.ts";
import { createApp } from "@zakki/web/server/app.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";

/**
 * issue #43: GET /api/crypto/envelopes。封筒（wrapped DEK / salt / KDF パラメータ /
 * credentialId）は KEK 無しには開けない公開可能情報で、サーバは平文 DEK を一切
 * 返さない（#28）。keyfile 封筒はサーバ端末ローカルの KEK 専用なのでクライアントへは
 * 返さない。issue #103: passkey 封筒の配布・登録（POST /api/crypto/envelopes/passkey。
 * 平文 DEK・PRF 出力は wire に流れない）。
 */
let db: Db;
let app: Hono;

beforeEach(async () => {
  await ready();
  db = await createDb(":memory:");
  app = createApp({ db });
});

async function getEnvelopes(): Promise<{ envelopes: CryptoEnvelope[] }> {
  const res = await app.request("/api/crypto/envelopes");
  expect(res.status).toBe(200);
  return (await res.json()) as { envelopes: CryptoEnvelope[] };
}

describe("GET /api/crypto/envelopes", () => {
  test("B1: 封筒なし（暗号未プロビジョン）→ { envelopes: [] }", async () => {
    expect(await getEnvelopes()).toEqual({ envelopes: [] });
  });

  test("B2: passphrase 封筒を base64 で返し、keyfile 封筒は含まない", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "ひみつのパスフレーズ");
    await addKeyfileEnvelope(db, dek, generateDek());

    const { envelopes } = await getEnvelopes();
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    if (env === undefined) throw new Error("envelope が空");
    if (env.kind === "passkey") throw new Error("passkey 封筒ではないはず");
    expect(env.kind).toBe("passphrase");
    expect(typeof env.wrappedDek).toBe("string");
    expect(typeof env.kdfSalt).toBe("string");
    expect(env.kdfOps).toBeGreaterThan(0);
    expect(env.kdfMem).toBeGreaterThan(0);
  });

  test("B3: 返った封筒はクライアント openEnvelope（正しいパスフレーズ）で元の DEK に戻る", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "ひみつのパスフレーズ");

    const { envelopes } = await getEnvelopes();
    const env = envelopes[0];
    if (env === undefined) throw new Error("envelope が空");
    if (env.kind === "passkey") throw new Error("passkey 封筒ではないはず");
    expect(openEnvelope(env, "ひみつのパスフレーズ")).toEqual(dek);
    expect(() => openEnvelope(env, "まちがい")).toThrow();
  });

  test("B4: passkey 封筒は credentialId 付きで配布され、openPasskeyEnvelope で開ける（#103）", async () => {
    const dek = generateDek();
    const prf = sodium.randombytes_buf(32);
    await addPasskeyEnvelope(db, dek, prf, "cred-wire");

    const { envelopes } = await getEnvelopes();
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    if (env === undefined || env.kind !== "passkey") throw new Error("passkey 封筒が無い");
    expect(env.credentialId).toBe("cred-wire");
    expect(typeof env.wrappedDek).toBe("string");
    // wire に kdf メタ・平文 DEK・PRF 出力は現れない
    expect("kdfSalt" in env).toBe(false);
    expect(env.wrappedDek).not.toBe(sodium.to_base64(dek, sodium.base64_variants.ORIGINAL));

    expect(openPasskeyEnvelope(env, prf)).toEqual(dek);
    expect(() => openPasskeyEnvelope(env, sodium.randombytes_buf(32))).toThrow();
  });
});

describe("POST /api/crypto/envelopes/passkey (#103)", () => {
  const post = (body: unknown) =>
    app.request("/api/crypto/envelopes/passkey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("B5: 既存封筒ありの DB で wrap 済み封筒を保存し（200）、配布・アンロックに現れる", async () => {
    const dek = generateDek();
    // 事前条件: DEK 確立済み（既存封筒が 1 つ以上ある）DB にのみ登録できる
    await addPassphraseEnvelope(db, dek, "既存のパスフレーズ");
    const prf = sodium.randombytes_buf(32);
    const wrapped = wrapDek(dek, deriveKekFromPrf(prf));

    const res = await post({
      wrappedDek: sodium.to_base64(wrapped, sodium.base64_variants.ORIGINAL),
      credentialId: "cred-post",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await getPasskeyCredentialId(db)).toBe("cred-post");
    expect(await unlockWithPasskey(db, prf)).toEqual(dek);
  });

  test("B6: 不正 base64・欠落フィールド・空文字は 400", async () => {
    expect((await post({ wrappedDek: "%%%invalid%%%", credentialId: "c" })).status).toBe(400);
    expect((await post({ credentialId: "c" })).status).toBe(400);
    expect((await post({ wrappedDek: "QUJD" })).status).toBe(400);
    expect((await post({ wrappedDek: "", credentialId: "c" })).status).toBe(400);
    expect((await post({ wrappedDek: "QUJD", credentialId: "" })).status).toBe(400);
  });

  test("B7: wrappedDek が 72 バイト（nonce 24 + DEK 32 + tag 16）以外は 400", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "既存のパスフレーズ");
    const b64 = (n: number) =>
      sodium.to_base64(sodium.randombytes_buf(n), sodium.base64_variants.ORIGINAL);
    // 短い base64（"QUJD" = 3 バイト）・71/73 バイトは封筒としてあり得ない
    expect((await post({ wrappedDek: "QUJD", credentialId: "c" })).status).toBe(400);
    expect((await post({ wrappedDek: b64(71), credentialId: "c" })).status).toBe(400);
    expect((await post({ wrappedDek: b64(73), credentialId: "c" })).status).toBe(400);
    // ちょうど 72 バイトなら（中身がゴミでも形式上は）受理される
    expect((await post({ wrappedDek: b64(72), credentialId: "c" })).status).toBe(200);
  });

  test("B8: 封筒ゼロ（暗号未プロビジョン DB）への登録は 409、既存封筒があれば 200", async () => {
    const dek = generateDek();
    const prf = sodium.randombytes_buf(32);
    const wrapped = sodium.to_base64(
      wrapDek(dek, deriveKekFromPrf(prf)),
      sodium.base64_variants.ORIGINAL,
    );

    // 封筒ゼロ: passkey 封筒だけが入ると unlockOrSetup の初回判定
    // （kinds.length === 0）が壊れ TUI/CLI から復旧不能になるため拒否
    const denied = await post({ wrappedDek: wrapped, credentialId: "cred-409" });
    expect(denied.status).toBe(409);
    expect(await getPasskeyCredentialId(db)).toBeNull();

    // 既存封筒（= DEK 確立済み）があれば受理
    await addPassphraseEnvelope(db, dek, "既存のパスフレーズ");
    const accepted = await post({ wrappedDek: wrapped, credentialId: "cred-409" });
    expect(accepted.status).toBe(200);
    expect(await getPasskeyCredentialId(db)).toBe("cred-409");
    expect(await unlockWithPasskey(db, prf)).toEqual(dek);
  });
});
