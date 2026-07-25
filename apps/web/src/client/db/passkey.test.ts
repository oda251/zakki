import { beforeEach, describe, expect, test } from "bun:test";
import { generateDek, unwrapDek } from "@zakki/core/crypto/dek.ts";
import { deriveKekFromPrf, PRF_OUTPUT_BYTES } from "@zakki/core/crypto/kdf.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { addPassphraseEnvelope } from "@zakki/data/crypto/envelopes.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import {
  createPasskeyCredential,
  enrollPasskey,
  evaluatePrf,
  PRF_SALT,
  unlockWithPasskey,
} from "@zakki/web/client/db/passkey.ts";
import { fakeAuthenticator } from "@zakki/web/client/db/test-passkey.ts";
import { fetchEnvelopes } from "@zakki/web/client/db/unlock.ts";
import { createApp } from "@zakki/web/server/app.ts";

/**
 * issue #104: passkey（WebAuthn PRF）のクライアント登録・アンロック。
 * navigator.credentials はローカル再現不能なので、adapter 境界に fake 認証器を
 * プロトコルレベルで注入する（test-passkey.ts）。サーバは本物（Hono + SQLite）を使う。
 */
const PASSPHRASE = "passkey テスト用パスフレーズ";
const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
let serverDb: Db;
let app: Hono;
let fetchFn: FetchLike;
let dek: Uint8Array;

beforeEach(async () => {
  await ready();
  serverDb = await createDb(":memory:");
  app = createApp({ db: serverDb });
  fetchFn = async (input, init) => app.request(input, init);
  dek = generateDek();
  // passkey 封筒は既存封筒（DEK 確立済み）が前提（#103 の 409 ガード）
  await addPassphraseEnvelope(serverDb, dek, PASSPHRASE);
});

describe("PRF_SALT", () => {
  test("P0: 固定 salt は 32 バイト（PRF 出力長と同じ。アプリ定数で秘密ではない）", () => {
    expect(PRF_SALT.length).toBe(32);
  });
});

describe("createPasskeyCredential / evaluatePrf", () => {
  test("P1: 登録 → 同じ salt の PRF 評価は決定的な 32 バイトを返す", async () => {
    const api = fakeAuthenticator();
    const credentialId = await createPasskeyCredential(api);
    expect(api.credentialIds()).toEqual([credentialId]);

    const first = await evaluatePrf(api, [credentialId]);
    const second = await evaluatePrf(api, [credentialId]);
    expect(first.length).toBe(PRF_OUTPUT_BYTES);
    expect(first).toEqual(second);
  });

  test("P2: PRF 未対応の認証器は登録段階で拒否する（開けない封筒を作らない）", async () => {
    const api = fakeAuthenticator({ prfSupported: false });
    expect(createPasskeyCredential(api)).rejects.toThrow(/PRF/u);
  });

  test("P2: 登録後に PRF 対応が失われた（別ブラウザ）場合は評価が失敗する", async () => {
    const api = fakeAuthenticator();
    const credentialId = await createPasskeyCredential(api);
    api.setPrfSupported(false);
    expect(evaluatePrf(api, [credentialId])).rejects.toThrow(/PRF/u);
  });
});

describe("enrollPasskey", () => {
  test("P3: 封筒がサーバに保存され、wire には PRF 出力・平文 DEK が現れない", async () => {
    const api = fakeAuthenticator();
    const credentialId = await enrollPasskey(dek, api, { fetchFn });

    const envelopes = await fetchEnvelopes(fetchFn);
    const passkey = envelopes.find((e) => e.kind === "passkey");
    if (passkey === undefined) throw new Error("passkey 封筒が保存されていない");
    expect(passkey.credentialId).toBe(credentialId);

    // 封筒は PRF 由来 KEK でのみ開ける（= サーバは開けない）
    const prfOutput = await evaluatePrf(api, [credentialId]);
    const wrapped = sodium.from_base64(passkey.wrappedDek, sodium.base64_variants.ORIGINAL);
    expect(unwrapDek(wrapped, deriveKekFromPrf(prfOutput))).toEqual(dek);

    // wire の JSON に PRF 出力・平文 DEK のバイト列が含まれないこと
    const wire = JSON.stringify(envelopes);
    expect(wire).not.toContain(b64(dek));
    expect(wire).not.toContain(b64(prfOutput));
  });

  test("P4: 暗号未プロビジョン（封筒ゼロ）の DB には登録できない（サーバ 409）", async () => {
    const emptyDb = await createDb(":memory:");
    const emptyApp = createApp({ db: emptyDb });
    const emptyFetch: FetchLike = async (input, init) => emptyApp.request(input, init);
    expect(enrollPasskey(dek, fakeAuthenticator(), { fetchFn: emptyFetch })).rejects.toThrow();
  });
});

describe("unlockWithPasskey", () => {
  test("P5: 登録 → 再読込相当（新しい封筒フェッチ）→ 無言アンロックで DEK が戻る", async () => {
    const api = fakeAuthenticator();
    await enrollPasskey(dek, api, { fetchFn });

    // 再読込相当: 封筒をサーバから取り直し、prompt 無しでアンロックする
    const envelopes = await fetchEnvelopes(fetchFn);
    expect(await unlockWithPasskey(envelopes, api)).toEqual(dek);
  });

  test("P6: PRF 評価の失敗（キャンセル）は null（呼び出し側がパスフレーズへ落ちる）", async () => {
    const api = fakeAuthenticator();
    await enrollPasskey(dek, api, { fetchFn });
    const envelopes = await fetchEnvelopes(fetchFn);

    expect(await unlockWithPasskey(envelopes, fakeAuthenticator({ failGet: true }))).toBeNull();
  });

  test("P6: PRF 出力が別物（認証器が変わった）なら復号に失敗して null", async () => {
    const api = fakeAuthenticator();
    await enrollPasskey(dek, api, { fetchFn });
    const envelopes = await fetchEnvelopes(fetchFn);
    api.rotateSeed();

    expect(await unlockWithPasskey(envelopes, api)).toBeNull();
  });

  test("P7: passkey 封筒なし → null（認証器は呼ばれない）", async () => {
    const api = fakeAuthenticator();
    const envelopes = await fetchEnvelopes(fetchFn);
    expect(envelopes.some((e) => e.kind === "passkey")).toBe(false);
    expect(await unlockWithPasskey(envelopes, api)).toBeNull();
    expect(api.credentialIds()).toEqual([]);
  });

  test("P8: 未対応ブラウザ（adapter が null）→ null", async () => {
    const api = fakeAuthenticator();
    await enrollPasskey(dek, api, { fetchFn });
    const envelopes = await fetchEnvelopes(fetchFn);
    expect(await unlockWithPasskey(envelopes, null)).toBeNull();
  });
});
