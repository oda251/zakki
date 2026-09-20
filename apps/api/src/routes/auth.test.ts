import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createApp } from "@zakki/api/app.ts";
import { MAX_LIVE_OIDC_STATES } from "@zakki/api/auth/oidc-states.ts";
import {
  callback,
  createTestGoogleProvider,
  exchange,
  handoffCodeOf,
  loginWithIdp,
  startLogin,
  TEST_API_ORIGIN,
  TEST_APP_ORIGIN,
} from "@zakki/api/auth/test-login.ts";
import { createFakeIdp, type FakeIdp } from "@zakki/api/auth/test-oidc.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountIdentities, accounts, loginHandoffs, oidcStates } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/core/turso/platform.ts";

/**
 * OIDC ログインの統合検証。
 *
 * fetch ハンドラを直叩きし、DB は本物の libsql（migration 適用済み）を注入する。
 * プロバイダ（Google）はローカルで再現できないので fake IdP（auth/test-oidc.ts）を
 * HTTP の面で差し込み、アダプタ（oauth4webapi）は実体を通す。
 */

const SESSION_SECRET = "test-session-secret";
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

let db: ControlDb;
let app: ReturnType<typeof createApp>;
let idp: FakeIdp;

beforeEach(async () => {
  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  const path = join(mkdtempSync(join(tmpdir(), "zakki-auth-")), "control.sqlite");
  const client = createClient({ url: `file:${path}` });
  db = drizzle(client, { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  idp = await createFakeIdp();
  app = createApp({
    db,
    auth: { appOrigin: TEST_APP_ORIGIN, sessionSecret: SESSION_SECRET },
    providers: [createTestGoogleProvider(idp)],
    // 認証の検証に Turso は要らない。到達不能な base URL を入れておく
    turso: createTursoPlatform({
      baseUrl: "http://127.0.0.1:1",
      apiToken: "unused",
      organization: "unused",
      group: "unused",
    }),
  });
});

async function get(path: string, token?: string): Promise<Response> {
  return app.fetch(
    new Request(`${TEST_API_ORIGIN}${path}`, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}

async function post(path: string, token?: string): Promise<Response> {
  return app.fetch(
    new Request(`${TEST_API_ORIGIN}${path}`, {
      method: "POST",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}

/** 全端末ログアウト（issue #117） */
async function logout(token?: string): Promise<Response> {
  return post("/auth/logout", token);
}

/** コールバックの Location の fragment を読む */
function fragmentOf(response: Response): URLSearchParams {
  const location = new URL(response.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${TEST_APP_ORIGIN}/`);
  return new URLSearchParams(location.hash.slice(1));
}

describe("GET /auth/providers", () => {
  test("ログインに使えるプロバイダの id と表示名を返す", async () => {
    const res = await get("/auth/providers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [{ id: "google", name: "Google" }] });
  });
});

describe("GET /auth/oidc/:provider/start", () => {
  test("認可エンドポイントへ 302。PKCE / state / nonce / redirect_uri を載せる", async () => {
    const { response } = await startLogin(app);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${idp.issuer}/authorize`);
    const q = location.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(q.get("state")).toBeTruthy();
    expect(q.get("nonce")).toBeTruthy();
    expect(q.get("redirect_uri")).toBe(`${TEST_API_ORIGIN}/auth/oidc/google/callback`);
    expect(q.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
  });

  test("state を保管する（Workers はメモリに置けない）。verifier は URL に出さない", async () => {
    const started = await startLogin(app);
    const rows = await db.select().from(oidcStates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe(started.state);
    expect(rows[0]?.provider).toBe("google");
    expect(rows[0]?.nonce).toBe(started.nonce);
    const location = started.response.headers.get("location") ?? "";
    expect(location).not.toContain(rows[0]?.codeVerifier ?? "<none>");
  });

  test("毎回違う state / nonce を発行する", async () => {
    const a = await startLogin(app);
    const b = await startLogin(app);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
  });

  test("未知のプロバイダは 404（state を書かない）", async () => {
    const res = await get("/auth/oidc/unknown/start");
    expect(res.status).toBe(404);
    expect(await db.select().from(oidcStates)).toHaveLength(0);
  });

  test("生きている state が上限に達していたら 429（行を増やさない）", async () => {
    const expiresAt = Date.now() + 60_000;
    for (let i = 0; i < MAX_LIVE_OIDC_STATES; i++) {
      await db.insert(oidcStates).values({
        state: `s-${i}`,
        provider: "google",
        codeVerifier: "v",
        nonce: "n",
        expiresAt,
      });
    }
    const res = await get("/auth/oidc/google/start");
    expect(res.status).toBe(429);
    expect(await db.select().from(oidcStates)).toHaveLength(MAX_LIVE_OIDC_STATES);
  });

  test("期限切れの state は上限に数えない（発行時に掃除する）", async () => {
    for (let i = 0; i < MAX_LIVE_OIDC_STATES; i++) {
      await db.insert(oidcStates).values({
        state: `s-${i}`,
        provider: "google",
        codeVerifier: "v",
        nonce: "n",
        expiresAt: Date.now() - 1,
      });
    }
    await startLogin(app);
    expect(await db.select().from(oidcStates)).toHaveLength(1);
  });
});

describe("GET /auth/oidc/:provider/callback", () => {
  test("初回ログインで account と identity を作り、handoff code 付きで SPA へ戻す", async () => {
    const started = await startLogin(app);
    const res = await callback(app, idp, started, { subject: "sub-1", email: "me@example.com" });
    expect(res.status).toBe(302);
    const code = fragmentOf(res).get("login");
    expect(code).toBeTruthy();

    const identities = await db.select().from(accountIdentities);
    expect(identities).toHaveLength(1);
    // 新規アカウントの最初（今は唯一）の identity が主（issue #159）
    expect(identities[0]).toMatchObject({
      provider: "google",
      subject: "sub-1",
      email: "me@example.com",
      isPrimary: 1,
    });
    expect(await db.select().from(accounts)).toHaveLength(1);
    const handoffs = await db.select().from(loginHandoffs);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.code).toBe(code ?? "<none>");
    expect(handoffs[0]?.accountId).toBe(identities[0]?.accountId ?? "<none>");
  });

  test("同じ subject の 2 回目は新しい account を作らず、同じ accountId に入る", async () => {
    const first = await loginWithIdp(app, idp, { subject: "sub-1" });
    const second = await loginWithIdp(app, idp, { subject: "sub-1" });
    expect(second.accountId).toBe(first.accountId);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(accountIdentities)).toHaveLength(1);
  });

  test("subject が違えば別アカウント（メールが同じでも同定に使わない）", async () => {
    const a = await loginWithIdp(app, idp, { subject: "sub-a", email: "same@example.com" });
    const b = await loginWithIdp(app, idp, { subject: "sub-b", email: "same@example.com" });
    expect(a.accountId).not.toBe(b.accountId);
  });

  test("state は単回使用。消費後は同じ state で戻っても login_error=state", async () => {
    const started = await startLogin(app);
    expect((await callback(app, idp, started, { subject: "s" })).status).toBe(302);
    expect(await db.select().from(oidcStates)).toHaveLength(0);

    const replay = await callback(app, idp, started, { subject: "s" });
    expect(replay.status).toBe(302);
    expect(fragmentOf(replay).get("login_error")).toBe("state");
    expect(await db.select().from(loginHandoffs)).toHaveLength(1);
  });

  test("発行していない state は login_error=state（account を作らない）", async () => {
    const started = await startLogin(app);
    const res = await callback(app, idp, { ...started, state: "forged" }, { subject: "s" });
    expect(fragmentOf(res).get("login_error")).toBe("state");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  test("期限切れの state は login_error=state", async () => {
    const started = await startLogin(app);
    await db
      .update(oidcStates)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(oidcStates.state, started.state));
    const res = await callback(app, idp, started, { subject: "s" });
    expect(fragmentOf(res).get("login_error")).toBe("state");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  test("別プロバイダ用の state を流し込めない（login_error=state）", async () => {
    const started = await startLogin(app);
    await db
      .update(oidcStates)
      .set({ provider: "other" })
      .where(eq(oidcStates.state, started.state));
    const res = await callback(app, idp, started, { subject: "s" });
    expect(fragmentOf(res).get("login_error")).toBe("state");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  test("同意を拒否された（error=access_denied）なら login_error=denied。state は消費する", async () => {
    const started = await startLogin(app);
    const url = new URL(`${TEST_API_ORIGIN}/auth/oidc/google/callback`);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("state", started.state);
    const res = await app.fetch(new Request(url));
    expect(res.status).toBe(302);
    expect(fragmentOf(res).get("login_error")).toBe("denied");
    expect(await db.select().from(oidcStates)).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  test("トークン交換に失敗したら login_error=provider（account を作らない）", async () => {
    const started = await startLogin(app);
    idp.failToken = true;
    const res = await callback(app, idp, started, { subject: "s" });
    expect(fragmentOf(res).get("login_error")).toBe("provider");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  test("id_token の nonce が start 時のものと違えば login_error=provider", async () => {
    const started = await startLogin(app);
    const res = await callback(app, idp, { ...started, nonce: "other-nonce" }, { subject: "s" });
    expect(fragmentOf(res).get("login_error")).toBe("provider");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });
});

describe("POST /auth/login/exchange", () => {
  test("handoff code をセッションに換える。トークンで /auth/me に到達できる", async () => {
    const started = await startLogin(app);
    const cb = await callback(app, idp, started, { subject: "sub-1", email: "me@example.com" });
    const res = await exchange(app, handoffCodeOf(cb));
    expect(res.status).toBe(200);
    const session = (await res.json()) as {
      accountId: string;
      token: string;
      expiresAt: number;
    };
    expect(typeof session.expiresAt).toBe("number");
    const me = await get("/auth/me", session.token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ accountId: session.accountId });
  });

  test("応答にアカウント表示用の account（主 identity の email と provider）が載る（issue #159）", async () => {
    const started = await startLogin(app);
    const cb = await callback(app, idp, started, { subject: "sub-1", email: "me@example.com" });
    const res = await exchange(app, handoffCodeOf(cb));
    expect(res.status).toBe(200);
    const session = (await res.json()) as { account: unknown };
    expect(session.account).toEqual({
      email: "me@example.com",
      provider: { id: "google", name: "Google" },
    });
  });

  test("同じ code は二度使えない（単回使用）", async () => {
    const cb = await callback(app, idp, await startLogin(app), { subject: "s" });
    const code = handoffCodeOf(cb);
    expect((await exchange(app, code)).status).toBe(200);
    expect((await exchange(app, code)).status).toBe(401);
  });

  test("期限切れの code は 401", async () => {
    const cb = await callback(app, idp, await startLogin(app), { subject: "s" });
    const code = handoffCodeOf(cb);
    await db
      .update(loginHandoffs)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(loginHandoffs.code, code));
    expect((await exchange(app, code)).status).toBe(401);
  });

  test("発行していない code は 401", async () => {
    expect((await exchange(app, "never-issued")).status).toBe(401);
  });

  test("形の壊れたボディは 400", async () => {
    expect((await exchange(app, 123)).status).toBe(400);
  });
});

describe("GET /auth/me（requireSession）", () => {
  test("Authorization ヘッダが無ければ 401", async () => {
    expect((await get("/auth/me")).status).toBe(401);
  });

  test("署名の壊れたトークンは 401", async () => {
    const { token } = await loginWithIdp(app, idp, { subject: "s" });
    // 署名部の**先頭**文字を変える。末尾は有効ビットが 4 bit しかなく、下位 2 bit は
    // デコードで捨てられるため、変えても同じバイト列になり署名が壊れないことがある
    // （16 回に 1 回。me.test.ts の tampered() の注記）
    const [header, payload, signature = ""] = token.split(".");
    const head = signature.slice(0, 1);
    const tampered = `${header}.${payload}.${head === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect((await get("/auth/me", tampered)).status).toBe(401);
  });
});

describe("POST /auth/logout（セッションの一斉失効, issue #117）", () => {
  test("ログアウトすると同じ JWT では保護エンドポイントに到達できない", async () => {
    const { token } = await loginWithIdp(app, idp, { subject: "s" });
    expect((await get("/auth/me", token)).status).toBe(200);

    expect((await logout(token)).status).toBe(204);

    expect((await get("/auth/me", token)).status).toBe(401);
    // 署名不正・期限切れと同じ文言に潰す（何が起きたかを呼び出し側に区別させない）
    expect(await (await get("/auth/me", token)).json()).toEqual({ error: "セッションが無効です" });
  });

  test("台帳のセッション世代がちょうど 1 つ進む。アカウントと identity は残る", async () => {
    const { accountId, token } = await loginWithIdp(app, idp, { subject: "s" });
    const before = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(before[0]?.sessionEpoch).toBe(0);

    expect((await logout(token)).status).toBe(204);

    const after = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(after[0]?.sessionEpoch).toBe(1);
    expect(await db.select().from(accountIdentities)).toHaveLength(1);
  });

  test("ログアウト後に再ログインすると新しい世代のトークンで通常どおり使える", async () => {
    const first = await loginWithIdp(app, idp, { subject: "s" });
    expect((await logout(first.token)).status).toBe(204);

    const again = await loginWithIdp(app, idp, { subject: "s" });
    expect(again.accountId).toBe(first.accountId);
    expect(again.token).not.toBe(first.token);
    expect((await get("/auth/me", again.token)).status).toBe(200);
    expect((await get("/auth/me", first.token)).status).toBe(401);
  });

  test("同じアカウントの別端末のセッションも一緒に落ちる（全端末ログアウト）", async () => {
    const first = await loginWithIdp(app, idp, { subject: "s" });
    const second = await loginWithIdp(app, idp, { subject: "s" });
    expect((await logout(first.token)).status).toBe(204);
    expect((await get("/auth/me", first.token)).status).toBe(401);
    expect((await get("/auth/me", second.token)).status).toBe(401);
  });

  test("他アカウントのセッションは巻き添えにしない", async () => {
    const mine = await loginWithIdp(app, idp, { subject: "me" });
    const stranger = await loginWithIdp(app, idp, { subject: "stranger" });
    expect((await logout(mine.token)).status).toBe(204);
    expect((await get("/auth/me", mine.token)).status).toBe(401);
    expect((await get("/auth/me", stranger.token)).status).toBe(200);
  });

  test("二度目のログアウトは 401（世代は 1 つしか進まない）", async () => {
    const { accountId, token } = await loginWithIdp(app, idp, { subject: "s" });
    expect((await logout(token)).status).toBe(204);
    expect((await logout(token)).status).toBe(401);
    const rows = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(rows[0]?.sessionEpoch).toBe(1);
  });

  test("未認証・偽造トークンではログアウトできない", async () => {
    const { accountId } = await loginWithIdp(app, idp, { subject: "s" });
    expect((await logout()).status).toBe(401);
    expect((await logout("not-a-token")).status).toBe(401);
    const rows = await db.select().from(accounts).where(eq(accounts.id, accountId));
    expect(rows[0]?.sessionEpoch).toBe(0);
  });
});

describe("パスキー認証の撤去", () => {
  test.each([
    ["POST", "/auth/register/options"],
    ["POST", "/auth/register/verify"],
    ["POST", "/auth/login/options"],
    ["POST", "/auth/login/verify"],
    ["GET", "/auth/credentials"],
    ["POST", "/auth/credentials/options"],
  ])("%s %s は 404", async (method, path) => {
    const res = await app.fetch(new Request(`${TEST_API_ORIGIN}${path}`, { method }));
    expect(res.status).toBe(404);
  });
});
