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
  evaluatePrf,
  healPasskeyEnvelope,
  PRF_SALT,
  revokePasskeyEnvelope,
  savePasskeyEnvelope,
  unlockWithPasskey,
} from "@zakki/web/client/db/passkey.ts";
import type { FakeAuthenticator } from "@zakki/web/client/db/test-passkey.ts";
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

/**
 * 失敗を **await して** 検証する。bun の型では `expect(...).rejects.toThrow()` が
 * void を返し await できない（型なしで放置すると assertion がテスト外で解決してしまう）
 */
async function expectRejects(promise: Promise<unknown>, pattern?: RegExp): Promise<void> {
  let error: unknown = null;
  try {
    await promise;
  } catch (err: unknown) {
    error = err;
  }
  expect(error).not.toBeNull();
  if (pattern !== undefined) expect(String(error)).toMatch(pattern);
}

/** 登録 2 段（作成 → 保存）をまとめた、テスト内での定型 */
async function enroll(api: FakeAuthenticator): Promise<string> {
  const credentialId = await createPasskeyCredential(api);
  await savePasskeyEnvelope(dek, api, credentialId, { fetchFn });
  return credentialId;
}

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
    expect(first.prfOutput.length).toBe(PRF_OUTPUT_BYTES);
    expect(first.credentialId).toBe(credentialId);
    expect(first).toEqual(second);
  });

  test("P1b: クレデンシャルごとに PRF 出力は別（封筒を鍵ごとに持つ理由, #120）", async () => {
    const api = fakeAuthenticator();
    const first = await createPasskeyCredential(api);
    const second = await createPasskeyCredential(api);
    expect(first).not.toBe(second);

    const forFirst = await evaluatePrf(api, [first]);
    const forSecond = await evaluatePrf(api, [second]);
    expect(forFirst.credentialId).toBe(first);
    expect(forSecond.credentialId).toBe(second);
    expect(forFirst.prfOutput).not.toEqual(forSecond.prfOutput);
  });

  test("P2: PRF 未対応の認証器は登録段階で拒否する（開けない封筒を作らない）", async () => {
    const api = fakeAuthenticator({ prfSupported: false });
    await expectRejects(createPasskeyCredential(api), /PRF/u);
  });

  test("P2: 登録後に PRF 対応が失われた（別ブラウザ）場合は評価が失敗する", async () => {
    const api = fakeAuthenticator();
    const credentialId = await createPasskeyCredential(api);
    api.setPrfSupported(false);
    await expectRejects(evaluatePrf(api, [credentialId]), /PRF/u);
  });
});

describe("createPasskeyCredential → savePasskeyEnvelope（登録の 2 段）", () => {
  test("P3: 封筒がサーバに保存され、wire には PRF 出力・平文 DEK が現れない", async () => {
    const api = fakeAuthenticator();
    const credentialId = await createPasskeyCredential(api);
    await savePasskeyEnvelope(dek, api, credentialId, { fetchFn });

    const envelopes = await fetchEnvelopes(fetchFn);
    const passkey = envelopes.find((e) => e.kind === "passkey");
    if (passkey === undefined) throw new Error("passkey 封筒が保存されていない");
    expect(passkey.credentialId).toBe(credentialId);

    // 封筒は PRF 由来 KEK でのみ開ける（= サーバは開けない）
    const { prfOutput } = await evaluatePrf(api, [credentialId]);
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
    const api = fakeAuthenticator();
    const credentialId = await createPasskeyCredential(api);
    await expectRejects(savePasskeyEnvelope(dek, api, credentialId, { fetchFn: emptyFetch }));
  });

  test("P4b: 2 段目（PRF 評価）が弾かれても、同じ credentialId で保存だけやり直せる（Safari 対応）", async () => {
    const api = fakeAuthenticator();
    const credentialId = await createPasskeyCredential(api);
    // 作成のジェスチャを使い切り、続く get が NotAllowedError になる状況
    api.setFailGet(true);
    await expectRejects(savePasskeyEnvelope(dek, api, credentialId, { fetchFn }));
    expect((await fetchEnvelopes(fetchFn)).some((e) => e.kind === "passkey")).toBe(false);

    // 「続けて認証する」= 別ジェスチャからの再実行（credential は作り直さない）
    api.setFailGet(false);
    await savePasskeyEnvelope(dek, api, credentialId, { fetchFn });
    const envelopes = await fetchEnvelopes(fetchFn);
    const passkey = envelopes.find((e) => e.kind === "passkey");
    expect(passkey?.credentialId).toBe(credentialId);
    expect(api.credentialIds()).toEqual([credentialId]);
    expect(await unlockWithPasskey(envelopes, api)).toEqual(dek);
  });
});

describe("unlockWithPasskey", () => {
  test("P5: 登録 → 再読込相当（新しい封筒フェッチ）→ 無言アンロックで DEK が戻る", async () => {
    const api = fakeAuthenticator();
    await enroll(api);

    // 再読込相当: 封筒をサーバから取り直し、prompt 無しでアンロックする
    const envelopes = await fetchEnvelopes(fetchFn);
    expect(await unlockWithPasskey(envelopes, api)).toEqual(dek);
  });

  test("P6: PRF 評価の失敗（キャンセル）は null（呼び出し側がパスフレーズへ落ちる）", async () => {
    const api = fakeAuthenticator();
    await enroll(api);
    const envelopes = await fetchEnvelopes(fetchFn);

    expect(await unlockWithPasskey(envelopes, fakeAuthenticator({ failGet: true }))).toBeNull();
  });

  test("P6: PRF 出力が別物（認証器が変わった）なら復号に失敗して null", async () => {
    const api = fakeAuthenticator();
    await enroll(api);
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
    await enroll(api);
    const envelopes = await fetchEnvelopes(fetchFn);
    expect(await unlockWithPasskey(envelopes, null)).toBeNull();
  });
});

/**
 * issue #120: パスキーを 2 本登録した状態。PRF 出力は鍵ごとに違うので封筒も 2 本になり、
 * **どちらか一方だけでも** アンロックできる（機種変更・デバイス追加の実体）。
 */
describe("複数パスキー（issue #120）", () => {
  test("P9: 2 本登録 → どちらのパスキー単独でも同じ DEK が開く", async () => {
    // 別々の認証器 = スマホとノート PC（seed も credentialId も独立）
    const phone = fakeAuthenticator();
    const laptop = fakeAuthenticator();
    const phoneId = await enroll(phone);
    const laptopId = await enroll(laptop);
    expect(phoneId).not.toBe(laptopId);

    const envelopes = await fetchEnvelopes(fetchFn);
    const passkeys = envelopes.filter((e) => e.kind === "passkey");
    expect(passkeys.map((e) => e.credentialId).toSorted()).toEqual([phoneId, laptopId].toSorted());

    // それぞれの端末には自分のパスキーしかない。相手の封筒は開けなくても構わない
    expect(await unlockWithPasskey(envelopes, phone)).toEqual(dek);
    expect(await unlockWithPasskey(envelopes, laptop)).toEqual(dek);
  });

  test("P10: 同じ認証器に 2 本ある場合、ユーザが選んだ方の封筒が開く", async () => {
    const api = fakeAuthenticator();
    const first = await enroll(api);
    const second = await enroll(api);
    const envelopes = await fetchEnvelopes(fetchFn);

    api.setSelectedCredential(second);
    expect(await unlockWithPasskey(envelopes, api)).toEqual(dek);
    api.setSelectedCredential(first);
    expect(await unlockWithPasskey(envelopes, api)).toEqual(dek);
  });

  test("P11: 1 本を失効（封筒削除）してももう 1 本で開ける", async () => {
    const phone = fakeAuthenticator();
    const laptop = fakeAuthenticator();
    const phoneId = await enroll(phone);
    await enroll(laptop);

    // 失効の 2 段階目（クレデンシャル本体はコントロールプレーン DB 側の責務）
    await revokePasskeyEnvelope(phoneId, { fetchFn });

    const envelopes = await fetchEnvelopes(fetchFn);
    expect(envelopes.filter((e) => e.kind === "passkey")).toHaveLength(1);
    // 失効した端末では封筒が無いので開けない（パスフレーズへ落ちる）
    expect(await unlockWithPasskey(envelopes, phone)).toBeNull();
    // 残した端末は今までどおり開ける
    expect(await unlockWithPasskey(envelopes, laptop)).toEqual(dek);

    // 冪等: 消えたあとの再実行も失敗しない（2 段階削除のやり直し）
    await revokePasskeyEnvelope(phoneId, { fetchFn });
  });

  test("P12: allowCredentials を無視した認証器の応答は開かず null（総当たりしない）", async () => {
    const api = fakeAuthenticator();
    await enroll(api);
    const envelopes = await fetchEnvelopes(fetchFn);
    // 封筒に無い credential id で応答する認証器（プロトコル違反の再現）
    const rogue = {
      create: () => Promise.reject(new Error("使わない")),
      get: () =>
        Promise.resolve({
          id: "cred-unknown",
          type: "public-key",
          getClientExtensionResults: () => ({
            prf: { results: { first: new Uint8Array(PRF_OUTPUT_BYTES) } },
          }),
        }),
    };
    expect(await unlockWithPasskey(envelopes, rogue)).toBeNull();
  });

  test("P12b: 解釈できない credentialId が 1 本混ざっても、他のパスキーは巻き添えにならない", async () => {
    const api = fakeAuthenticator();
    await enroll(api);
    const envelopes = await fetchEnvelopes(fetchFn);
    // 何らかの経路で壊れた id が入った状態を再現する。候補の組み立てで throw すると
    // 封筒が N 本ある状況では「全部のパスキーが使えない」に化ける（#120 レビュー所見）
    const broken = [
      { kind: "passkey" as const, wrappedDek: "AAAA", credentialId: "not/base64url" },
      ...envelopes,
    ];
    expect(await unlockWithPasskey(broken, api)).toEqual(dek);
  });
});

describe("healPasskeyEnvelope（自己修復, issue #120）", () => {
  test("P13: 封筒が無いクレデンシャルの PRF を渡すと封筒を作る（生体認証は追加で求めない）", async () => {
    const api = fakeAuthenticator();
    // 登録の 2 段目（封筒 POST）だけ失敗した状態＝クレデンシャルはあるが封筒が無い
    const credentialId = await createPasskeyCredential(api);
    const envelopes = await fetchEnvelopes(fetchFn);
    expect(envelopes.some((e) => e.kind === "passkey")).toBe(false);

    // ログイン時に評価済みの PRF（#105）をそのまま使う: get は呼ばれない
    const prf = await evaluatePrf(api, [credentialId]);
    let gets = 0;
    const counted = {
      ...api,
      get: (options: CredentialRequestOptions) => {
        gets += 1;
        return api.get(options);
      },
    };
    expect(await healPasskeyEnvelope(dek, prf, envelopes, { fetchFn })).toBe(true);
    expect(gets).toBe(0);

    // 修復した封筒はそのパスキーで開ける
    const healed = await fetchEnvelopes(fetchFn);
    expect(await unlockWithPasskey(healed, counted)).toEqual(dek);
    expect(gets).toBe(1);
  });

  test("P14: 既に封筒があるクレデンシャル・PRF 未評価（null）なら何もしない", async () => {
    const api = fakeAuthenticator();
    const credentialId = await enroll(api);
    const envelopes = await fetchEnvelopes(fetchFn);
    const prf = await evaluatePrf(api, [credentialId]);

    expect(await healPasskeyEnvelope(dek, prf, envelopes, { fetchFn })).toBe(false);
    expect(await healPasskeyEnvelope(dek, null, envelopes, { fetchFn })).toBe(false);
    expect((await fetchEnvelopes(fetchFn)).filter((e) => e.kind === "passkey")).toHaveLength(1);
  });

  test("P15: 保存に失敗しても例外にしない（起動を止めない）", async () => {
    const api = fakeAuthenticator();
    const credentialId = await createPasskeyCredential(api);
    const prf = await evaluatePrf(api, [credentialId]);
    // 暗号未プロビジョン（封筒ゼロ）の DB は 409 を返す
    const emptyApp = createApp({ db: await createDb(":memory:") });
    const emptyFetch: FetchLike = async (input, init) => emptyApp.request(input, init);
    expect(await healPasskeyEnvelope(dek, prf, [], { fetchFn: emptyFetch })).toBe(false);
  });
});
