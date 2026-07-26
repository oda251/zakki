import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createApp } from "@zakki/api/app.ts";
import { createSoftAuthenticator, type SoftAuthenticator } from "@zakki/api/auth/test-fixtures.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accounts, authChallenges, credentials } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/api/turso/platform.ts";

/**
 * パスキー認証の統合検証（issue #100）。
 *
 * fetch ハンドラを直叩きし、DB は本物の libsql（migration 適用済み）を注入する。
 * 認証器だけはローカルで再現できないので、WebCrypto の P-256 鍵で本物の
 * attestation / assertion を組み立てて POST する（test-fixtures.ts）。
 * @simplewebauthn のメソッドは mock しない: 署名・rpIdHash・counter の検証を
 * 実体で通すことに価値がある（~/.references/policy/testing.md）。
 */

const RP_ID = "zakki.test";
const RP_ORIGIN = "https://zakki.test";
const SESSION_SECRET = "test-session-secret";
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

let db: ControlDb;
let app: ReturnType<typeof createApp>;
let authenticator: SoftAuthenticator;

beforeEach(async () => {
  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  // （db/schema.test.ts と同じ理由）
  const path = join(mkdtempSync(join(tmpdir(), "zakki-auth-")), "control.sqlite");
  const client = createClient({ url: `file:${path}` });
  db = drizzle(client, { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = createApp({
    db,
    auth: { rpId: RP_ID, rpOrigin: RP_ORIGIN, sessionSecret: SESSION_SECRET },
    // 認証の検証に Turso は要らない。到達不能な base URL を入れておく
    // （プロビジョニングの検証は routes/me.test.ts）
    turso: createTursoPlatform({
      baseUrl: "http://127.0.0.1:1",
      apiToken: "unused",
      organization: "unused",
      group: "unused",
    }),
  });
  authenticator = await createSoftAuthenticator(RP_ID);
});

async function post(path: string, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`https://control.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

async function get(path: string, token?: string): Promise<Response> {
  return app.fetch(
    new Request(`https://control.test${path}`, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}

/** 登録 options を取り、challenge を返す */
async function registerOptions(): Promise<{ challenge: string; options: Record<string, unknown> }> {
  const res = await post("/auth/register/options");
  expect(res.status).toBe(200);
  const options = (await res.json()) as Record<string, unknown>;
  return { challenge: options["challenge"] as string, options };
}

/** 正常な登録を一度通し、セッションと accountId を返す */
async function registerAccount(): Promise<{ accountId: string; token: string }> {
  const { challenge } = await registerOptions();
  const payload = await authenticator.attest({ challenge, origin: RP_ORIGIN });
  const res = await post("/auth/register/verify", payload);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { accountId: string; token: string };
  return body;
}

/** ログイン options を取り、challenge を返す */
async function loginChallenge(): Promise<string> {
  const res = await post("/auth/login/options");
  expect(res.status).toBe(200);
  const options = (await res.json()) as { challenge: string };
  return options.challenge;
}

/** 登録済みのパスキーで実際にログインし、新しいセッションを得る */
async function login(
  device: SoftAuthenticator = authenticator,
  counter = 1,
): Promise<{ accountId: string; token: string }> {
  const assertion = await device.assert({
    challenge: await loginChallenge(),
    origin: RP_ORIGIN,
    counter,
  });
  const res = await post("/auth/login/verify", assertion);
  expect(res.status).toBe(200);
  return (await res.json()) as { accountId: string; token: string };
}

/** 全端末ログアウト（issue #117） */
async function logout(token?: string): Promise<Response> {
  return app.fetch(
    new Request("https://control.test/auth/logout", {
      method: "POST",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}

describe("POST /auth/register/options", () => {
  test("PRF extension を有効にした registration options を返す（Phase 8 が同じ鍵を使うため）", async () => {
    const { options } = await registerOptions();
    expect(options["extensions"]).toMatchObject({ prf: {} });
    expect(options["rp"]).toMatchObject({ id: RP_ID });
    // パスワードレス: ID 入力なしでログインでき、UV が唯一の要素として必須
    expect(options["authenticatorSelection"]).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
  });

  test("発行した challenge を有効期限つきで保存する（Workers はメモリに置けない）", async () => {
    const { challenge } = await registerOptions();
    const rows = await db.select().from(authChallenges);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.challenge).toBe(challenge);
    expect(rows[0]?.kind).toBe("registration");
    expect(rows[0]?.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("パスキーの登録 → ログイン → 保護エンドポイント", () => {
  test("登録すると accounts / credentials が書かれ、セッションで /auth/me に到達できる", async () => {
    const { accountId, token } = await registerAccount();

    const stored = await db.select().from(credentials);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.accountId).toBe(accountId);
    expect(stored[0]?.credentialId).toBe(authenticator.credentialId);
    expect(stored[0]?.transports).toBe(JSON.stringify(["internal"]));

    const me = await get("/auth/me", token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ accountId });
  });

  test("登録済みのパスキーでログインでき、同じ accountId のセッションが出る", async () => {
    const registered = await registerAccount();

    const assertion = await authenticator.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 1,
    });
    const res = await post("/auth/login/verify", assertion);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accountId: string; token: string };
    expect(body.accountId).toBe(registered.accountId);

    const me = await get("/auth/me", body.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ accountId: registered.accountId });
  });

  test("ログイン成功で counter を認証器の報告値へ進める（クローン検知の基準）", async () => {
    await registerAccount();
    const assertion = await authenticator.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 7,
    });
    expect((await post("/auth/login/verify", assertion)).status).toBe(200);

    const stored = await db
      .select()
      .from(credentials)
      .where(eq(credentials.credentialId, authenticator.credentialId));
    expect(stored[0]?.counter).toBe(7);
  });
});

describe("登録の異常系", () => {
  test("発行していない challenge は 401（accounts を作らない）", async () => {
    await registerOptions();
    const payload = await authenticator.attest({
      challenge: "bm90LWFuLWlzc3VlZC1jaGFsbGVuZ2U",
      origin: RP_ORIGIN,
    });
    const res = await post("/auth/register/verify", payload);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("challenge") });
    expect(await db.select().from(credentials)).toEqual([]);
  });

  test("origin 不一致は 401（challenge は正しくても通さない）", async () => {
    const { challenge } = await registerOptions();
    const payload = await authenticator.attest({ challenge, origin: "https://evil.test" });
    const res = await post("/auth/register/verify", payload);
    expect(res.status).toBe(401);
    expect(await db.select().from(credentials)).toEqual([]);
  });

  test("期限切れの challenge は 401（期限切れと分かるメッセージ）", async () => {
    const { challenge } = await registerOptions();
    await db
      .update(authChallenges)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(authChallenges.challenge, challenge));

    const payload = await authenticator.attest({ challenge, origin: RP_ORIGIN });
    const res = await post("/auth/register/verify", payload);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("有効期限") });
  });

  test("同じ challenge は二度使えない（単回使用）", async () => {
    const { challenge } = await registerOptions();
    const payload = await authenticator.attest({ challenge, origin: RP_ORIGIN });
    expect((await post("/auth/register/verify", payload)).status).toBe(200);

    const replay = await post("/auth/register/verify", payload);
    expect(replay.status).toBe(401);
  });

  test("ログイン用の challenge を登録に流用できない（用途の取り違え）", async () => {
    const challenge = await loginChallenge();
    const payload = await authenticator.attest({ challenge, origin: RP_ORIGIN });
    const res = await post("/auth/register/verify", payload);
    expect(res.status).toBe(401);
  });

  test("clientData の type が webauthn.create でなければ 401（儀式の取り違え）", async () => {
    const { challenge } = await registerOptions();
    const payload = await authenticator.attest({
      challenge,
      origin: RP_ORIGIN,
      type: "webauthn.get",
    });
    const res = await post("/auth/register/verify", payload);
    expect(res.status).toBe(401);
    expect(await db.select().from(credentials)).toEqual([]);
  });

  test("形の壊れたボディは 400", async () => {
    expect((await post("/auth/register/verify", { id: "x" })).status).toBe(400);
  });
});

describe("ログインの異常系", () => {
  test("未登録のクレデンシャルは 401", async () => {
    await registerAccount();
    const stranger = await createSoftAuthenticator(RP_ID);
    const assertion = await stranger.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 1,
    });
    const res = await post("/auth/login/verify", assertion);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("未登録") });
  });

  test("counter の巻き戻しは 401（クローン検知）", async () => {
    await registerAccount();
    const first = await authenticator.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 5,
    });
    expect((await post("/auth/login/verify", first)).status).toBe(200);

    const rolledBack = await authenticator.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 3,
    });
    expect((await post("/auth/login/verify", rolledBack)).status).toBe(401);
    // 巻き戻しを受け入れて counter を下げてしまわないこと
    const stored = await db.select().from(credentials);
    expect(stored[0]?.counter).toBe(5);
  });

  test("origin 不一致は 401", async () => {
    await registerAccount();
    const assertion = await authenticator.assert({
      challenge: await loginChallenge(),
      origin: "https://evil.test",
      counter: 1,
    });
    expect((await post("/auth/login/verify", assertion)).status).toBe(401);
  });

  test("別の RP ID で署名された assertion は 401（rpIdHash 不一致）", async () => {
    await registerAccount();
    // 同じ鍵ではないが、rpIdHash が違えば署名検証以前に弾かれることを見る
    const otherRp = await createSoftAuthenticator("evil.test");
    const assertion = await otherRp.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 1,
    });
    expect((await post("/auth/login/verify", assertion)).status).toBe(401);
  });

  test("発行していない challenge は 401", async () => {
    await registerAccount();
    const assertion = await authenticator.assert({
      challenge: "bm90LWFuLWlzc3VlZC1jaGFsbGVuZ2U",
      origin: RP_ORIGIN,
      counter: 1,
    });
    expect((await post("/auth/login/verify", assertion)).status).toBe(401);
  });

  test("UV されていない assertion は 401（パスキーが唯一の要素なので妥協しない）", async () => {
    await registerAccount();
    const assertion = await authenticator.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 1,
      userVerified: false,
    });
    expect((await post("/auth/login/verify", assertion)).status).toBe(401);
  });
});

describe("GET /auth/me（requireSession）", () => {
  test("Authorization ヘッダが無ければ 401", async () => {
    expect((await get("/auth/me")).status).toBe(401);
  });

  test("署名の壊れたトークンは 401", async () => {
    const { token } = await registerAccount();
    const tampered = `${token.slice(0, -2)}xy`;
    expect((await get("/auth/me", tampered)).status).toBe(401);
  });
});

describe("POST /auth/logout（セッションの一斉失効, issue #117）", () => {
  test("ログアウトすると同じ JWT では保護エンドポイントに到達できない", async () => {
    const { token } = await registerAccount();
    // 失効前は通る（この 3 つが requireActiveSession の適用先すべて）
    expect((await get("/auth/me", token)).status).toBe(200);
    expect((await get("/auth/credentials", token)).status).toBe(200);

    expect((await logout(token)).status).toBe(204);

    expect((await get("/auth/me", token)).status).toBe(401);
    expect((await get("/auth/credentials", token)).status).toBe(401);
    // 署名不正・期限切れと同じ文言に潰す（何が起きたかを呼び出し側に区別させない）
    expect(await (await get("/auth/me", token)).json()).toEqual({ error: "セッションが無効です" });
  });

  test("台帳のセッション世代がちょうど 1 つ進む（トークン側は据え置き）", async () => {
    const { accountId, token } = await registerAccount();
    const before = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(before[0]?.sessionEpoch).toBe(0);

    expect((await logout(token)).status).toBe(204);

    const after = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(after[0]?.sessionEpoch).toBe(1);
    // アカウント自体は残る（退会とは別物。パスキーもそのまま）
    expect(await db.select().from(credentials)).toHaveLength(1);
  });

  test("ログアウト後に再ログインすると新しい世代のトークンで通常どおり使える", async () => {
    const registered = await registerAccount();
    expect((await logout(registered.token)).status).toBe(204);

    const reloggedIn = await login();
    expect(reloggedIn.accountId).toBe(registered.accountId);
    expect(reloggedIn.token).not.toBe(registered.token);
    expect((await get("/auth/me", reloggedIn.token)).status).toBe(200);
    // 新しいトークンは通るのに、古いトークンは通らないまま
    expect((await get("/auth/me", registered.token)).status).toBe(401);
  });

  test("同じアカウントの別端末のセッションも一緒に落ちる（全端末ログアウト）", async () => {
    const first = await registerAccount();
    // 同じパスキーでもう 1 セッション（= 2 台目でログインした状態）
    const second = await login();
    expect((await get("/auth/me", second.token)).status).toBe(200);

    // 落とすのは片方のトークンからでよい
    expect((await logout(first.token)).status).toBe(204);
    expect((await get("/auth/me", first.token)).status).toBe(401);
    expect((await get("/auth/me", second.token)).status).toBe(401);
  });

  test("他アカウントのセッションは巻き添えにしない", async () => {
    const mine = await registerAccount();
    const otherDevice = await createSoftAuthenticator(RP_ID);
    authenticator = otherDevice;
    const stranger = await registerAccount();
    expect(stranger.accountId).not.toBe(mine.accountId);

    expect((await logout(mine.token)).status).toBe(204);
    expect((await get("/auth/me", mine.token)).status).toBe(401);
    expect((await get("/auth/me", stranger.token)).status).toBe(200);
  });

  test("二度目のログアウトは 401（同じトークンはもう使えない）", async () => {
    const { accountId, token } = await registerAccount();
    expect((await logout(token)).status).toBe(204);
    expect((await logout(token)).status).toBe(401);
    // 弾かれた分は世代を進めない（無効なトークンで世代を動かせない）
    const rows = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(rows[0]?.sessionEpoch).toBe(1);
  });

  test("未認証・偽造トークンではログアウトできない（他人のセッションを落とせない）", async () => {
    const { accountId } = await registerAccount();
    expect((await logout()).status).toBe(401);
    expect((await logout("not-a-token")).status).toBe(401);

    const rows = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(rows[0]?.sessionEpoch).toBe(0);
  });
});
