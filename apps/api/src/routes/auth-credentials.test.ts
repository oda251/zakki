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
import { accounts, credentials } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/api/turso/platform.ts";

/**
 * 既存アカウントへのパスキー追加・一覧・失効（issue #115）と表示名（issue #118）の
 * 統合検証。routes/auth.test.ts と同じ流儀で、@simplewebauthn は mock せず
 * WebCrypto のソフトウェア認証器で本物の attestation / assertion を組み立てて
 * 実エンドポイントへ POST する（~/.references/policy/testing.md）。
 *
 * 「2 台目の端末」は **別の認証器インスタンス**（別の鍵ペア・別の credentialId）で
 * 模す。追加したパスキー単独でログインして同じ accountId に着地することが、
 * この機能の本題（機種変更でアカウントを失わない）そのもの。
 */

const RP_ID = "zakki.test";
const RP_ORIGIN = "https://zakki.test";
const SESSION_SECRET = "test-session-secret";
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

let db: ControlDb;
let app: ReturnType<typeof createApp>;
/** 1 台目の端末の認証器。テストによっては 2 アカウント目のために差し替える */
let authenticator: SoftAuthenticator;

beforeEach(async () => {
  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  const path = join(mkdtempSync(join(tmpdir(), "zakki-cred-")), "control.sqlite");
  const client = createClient({ url: `file:${path}` });
  db = drizzle(client, { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = createApp({
    db,
    auth: { rpId: RP_ID, rpOrigin: RP_ORIGIN, sessionSecret: SESSION_SECRET },
    // クレデンシャル管理に Turso は要らない（到達不能な base URL を入れておく）
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

/** セッション付き POST（クレデンシャル管理は全て要認証） */
async function authPost(
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`https://control.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

async function del(path: string, token?: string): Promise<Response> {
  return app.fetch(
    new Request(`https://control.test${path}`, {
      method: "DELETE",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
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

/** 登録 options を取り、challenge と options 本体を返す */
async function registerOptions(): Promise<{ challenge: string; options: Record<string, unknown> }> {
  const res = await post("/auth/register/options");
  expect(res.status).toBe(200);
  const options = (await res.json()) as Record<string, unknown>;
  return { challenge: options["challenge"] as string, options };
}

/** 現在の `authenticator` で新規アカウントを 1 つ作る */
async function registerAccount(): Promise<{ accountId: string; token: string }> {
  const { challenge } = await registerOptions();
  const payload = await authenticator.attest({ challenge, origin: RP_ORIGIN });
  const res = await post("/auth/register/verify", payload);
  expect(res.status).toBe(200);
  return (await res.json()) as { accountId: string; token: string };
}

/** ログイン options を取り、challenge を返す */
async function loginChallenge(): Promise<string> {
  const res = await post("/auth/login/options");
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

/** options の `user.id`（base64url の user handle）を accountId 文字列に戻す */
function decodeUserHandle(base64url: string): string {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0)));
}

/** 追加・一覧 API が返すクレデンシャル（公開鍵は含まない） */
interface CredentialSummary {
  credentialId: string;
  displayName: string | null;
  createdAt: string;
}

/** ログイン済みセッションでパスキーを 1 本追加し、その認証器と応答を返す */
async function addCredential(
  token: string,
  label?: string,
): Promise<{ device: SoftAuthenticator; created: CredentialSummary }> {
  const optionsRes = await authPost(
    "/auth/credentials/options",
    token,
    label === undefined ? {} : { label },
  );
  expect(optionsRes.status).toBe(200);
  const options = (await optionsRes.json()) as { challenge: string };
  // 2 台目の端末 = 別の鍵ペアを持つ別の認証器
  const device = await createSoftAuthenticator(RP_ID);
  const payload = await device.attest({ challenge: options.challenge, origin: RP_ORIGIN });
  const res = await authPost("/auth/credentials/verify", token, payload);
  expect(res.status).toBe(200);
  return { device, created: (await res.json()) as CredentialSummary };
}

async function listCredentials(token: string): Promise<CredentialSummary[]> {
  const res = await get("/auth/credentials", token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { credentials: CredentialSummary[] }).credentials;
}

describe("既存アカウントへのパスキー追加（issue #115）", () => {
  test("2 本目を追加すると、その 1 本だけでログインして同じ accountId に着地する", async () => {
    const account = await registerAccount();
    const { device, created } = await addCredential(account.token);
    expect(created.credentialId).toBe(device.credentialId);

    // 追加した認証器**だけ**で discoverable ログインする（新端末を模す）
    const assertion = await device.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 1,
    });
    const res = await post("/auth/login/verify", assertion);
    expect(res.status).toBe(200);
    const session = (await res.json()) as { accountId: string; token: string };
    expect(session.accountId).toBe(account.accountId);

    // 同じアカウント = 同じ DB に着地する（/me は accountId をそのまま返す）
    const me = await get("/auth/me", session.token);
    expect(await me.json()).toEqual({ accountId: account.accountId });
  });

  test("追加は accounts を増やさず credentials だけを増やす（新規採番しない）", async () => {
    const account = await registerAccount();
    await addCredential(account.token);

    expect(await db.select().from(accounts)).toHaveLength(1);
    const stored = await db.select().from(credentials);
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.accountId === account.accountId)).toBe(true);
  });

  test("options は既存クレデンシャルを excludeCredentials に載せる（同一認証器の重複登録を防ぐ）", async () => {
    const account = await registerAccount();
    const res = await authPost("/auth/credentials/options", account.token);
    const options = (await res.json()) as {
      excludeCredentials: { id: string; transports: string[]; type: string }[];
      user: { id: string };
      extensions: unknown;
      authenticatorSelection: Record<string, unknown>;
    };
    expect(options.excludeCredentials).toEqual([
      { id: authenticator.credentialId, transports: ["internal"], type: "public-key" },
    ]);
    // userID は既存 accountId そのもの（新規採番していない）
    expect(decodeUserHandle(options.user.id)).toBe(account.accountId);
    // 追加したパスキーでも PRF を使えるようにする（#103 / #104 と同じ扱い）
    expect(options.extensions).toMatchObject({ prf: {} });
    // authenticatorAttachment を指定しない = cross-device（hybrid）を塞がない。
    // 新端末はまだログインできないので、この経路が機種変更の主導線になる
    expect(options.authenticatorSelection).not.toHaveProperty("authenticatorAttachment");
  });

  test("excludeCredentials を無視した認証器が同じ鍵を送っても 409（重複登録）", async () => {
    const account = await registerAccount();
    const optionsRes = await authPost("/auth/credentials/options", account.token);
    const options = (await optionsRes.json()) as { challenge: string };
    // 登録済みの認証器がそのまま attest する = excludeCredentials 無視
    const payload = await authenticator.attest({ challenge: options.challenge, origin: RP_ORIGIN });
    const res = await authPost("/auth/credentials/verify", account.token, payload);
    expect(res.status).toBe(409);
    expect(await db.select().from(credentials)).toHaveLength(1);
  });

  test("追加用の challenge を /auth/register/verify に流用できない（新規アカウントを生やさない）", async () => {
    const account = await registerAccount();
    const optionsRes = await authPost("/auth/credentials/options", account.token);
    const options = (await optionsRes.json()) as { challenge: string };
    const device = await createSoftAuthenticator(RP_ID);
    const payload = await device.attest({ challenge: options.challenge, origin: RP_ORIGIN });

    expect((await post("/auth/register/verify", payload)).status).toBe(401);
    expect(await db.select().from(accounts)).toHaveLength(1);
  });

  test("他アカウントのセッションでは challenge を横取りできない（401）", async () => {
    const owner = await registerAccount();
    const optionsRes = await authPost("/auth/credentials/options", owner.token);
    const options = (await optionsRes.json()) as { challenge: string };

    // 別アカウントを作り、そのセッションで owner 宛の challenge を verify する
    authenticator = await createSoftAuthenticator(RP_ID);
    const stranger = await registerAccount();
    const device = await createSoftAuthenticator(RP_ID);
    const payload = await device.attest({ challenge: options.challenge, origin: RP_ORIGIN });
    const res = await authPost("/auth/credentials/verify", stranger.token, payload);
    expect(res.status).toBe(401);
    expect(await db.select().from(credentials)).toHaveLength(2);
  });

  test("未認証では options / verify とも 401", async () => {
    const account = await registerAccount();
    expect((await authPost("/auth/credentials/options", undefined)).status).toBe(401);
    const optionsRes = await authPost("/auth/credentials/options", account.token);
    const options = (await optionsRes.json()) as { challenge: string };
    const device = await createSoftAuthenticator(RP_ID);
    const payload = await device.attest({ challenge: options.challenge, origin: RP_ORIGIN });
    expect((await authPost("/auth/credentials/verify", undefined, payload)).status).toBe(401);
    expect(await db.select().from(credentials)).toHaveLength(1);
  });
});

describe("GET /auth/credentials（一覧）", () => {
  test("登録済みのパスキーが並び、公開鍵・counter は返らない", async () => {
    const account = await registerAccount();
    await addCredential(account.token, "スマホ");

    const listed = await listCredentials(account.token);
    expect(listed).toHaveLength(2);
    expect(listed.map((row) => row.credentialId)).toContain(authenticator.credentialId);
    expect(listed.some((row) => row.displayName === "スマホ")).toBe(true);
    for (const row of listed) {
      expect(row.createdAt).toBeTruthy();
      expect(Object.keys(row).sort()).toEqual(["createdAt", "credentialId", "displayName"]);
    }
  });

  test("他アカウントのクレデンシャルは混ざらない", async () => {
    const first = await registerAccount();
    authenticator = await createSoftAuthenticator(RP_ID);
    const second = await registerAccount();
    await addCredential(second.token);

    expect(await listCredentials(first.token)).toHaveLength(1);
    expect(await listCredentials(second.token)).toHaveLength(2);
  });

  test("未認証は 401", async () => {
    expect((await get("/auth/credentials")).status).toBe(401);
  });
});

describe("DELETE /auth/credentials/:credentialId（失効）", () => {
  test("2 本のうち 1 本を失効させると 1 本になる", async () => {
    const account = await registerAccount();
    const { device } = await addCredential(account.token);

    expect((await del(`/auth/credentials/${device.credentialId}`, account.token)).status).toBe(200);

    const listed = await listCredentials(account.token);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.credentialId).toBe(authenticator.credentialId);
    // 失効した鍵ではもうログインできない
    const assertion = await device.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 1,
    });
    expect((await post("/auth/login/verify", assertion)).status).toBe(401);
  });

  test("最後の 1 本は失効できない（409、アカウントに入れなくなるため）", async () => {
    const account = await registerAccount();
    const res = await del(`/auth/credentials/${authenticator.credentialId}`, account.token);
    expect(res.status).toBe(409);
    expect(await db.select().from(credentials)).toHaveLength(1);
  });

  test("2 本を同時に失効させても 0 本にはならない", async () => {
    const account = await registerAccount();
    const second = await addCredential(account.token);
    expect(await db.select().from(credentials)).toHaveLength(2);

    // 不変条件（最後の 1 本は必ず残る）を並行実行で押さえる。
    // 注意: このテストはレース自体を決定的に再現するものではない（in-process の
    // libsql では read-then-write 実装でも通ってしまう）。実際の防御は DELETE 文に
    // 埋めた件数条件で、SQLite が 1 文を原子的に実行することに依っている
    const [a, b] = await Promise.all([
      del(`/auth/credentials/${authenticator.credentialId}`, account.token),
      del(`/auth/credentials/${second.created.credentialId}`, account.token),
    ]);

    const statuses = [a.status, b.status].toSorted((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    expect(await db.select().from(credentials)).toHaveLength(1);
  });

  test("他アカウントのクレデンシャルは失効できない（404 で在否も教えない）", async () => {
    const victim = await registerAccount();
    const victimCredentialId = authenticator.credentialId;
    authenticator = await createSoftAuthenticator(RP_ID);
    const attacker = await registerAccount();
    // 攻撃側は 2 本持っている（「最後の 1 本」判定より前で弾かれることを見る）
    await addCredential(attacker.token);

    const res = await del(`/auth/credentials/${victimCredentialId}`, attacker.token);
    expect(res.status).toBe(404);
    const stored = await db
      .select()
      .from(credentials)
      .where(eq(credentials.credentialId, victimCredentialId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.accountId).toBe(victim.accountId);
  });

  test("未認証は 401", async () => {
    const account = await registerAccount();
    expect((await del(`/auth/credentials/${authenticator.credentialId}`)).status).toBe(401);
    expect(await listCredentials(account.token)).toHaveLength(1);
  });
});

describe("パスキーの表示名（issue #118）", () => {
  test("userName と userDisplayName は別の値で、どちらも zakki 固定ではない", async () => {
    const { options } = await registerOptions();
    const user = options["user"] as { name: string; displayName: string; id: string };
    expect(user.name).not.toBe(user.displayName);
    // name はアカウント識別子（accountId 由来 + RP ID）
    const accountId = decodeUserHandle(user.id);
    expect(user.name).toBe(`${accountId.slice(0, 8)}@${RP_ID}`);
    // displayName は人間向けの名札。既定は登録日つき
    expect(user.displayName).toMatch(/^zakki \(\d{4}-\d{2}-\d{2}\)$/);
  });

  test("同じアカウントに追加したパスキーは userName が一致する（別アカウントに見えない）", async () => {
    const account = await registerAccount();
    const res = await authPost("/auth/credentials/options", account.token);
    const options = (await res.json()) as { user: { name: string } };
    expect(options.user.name).toBe(`${account.accountId.slice(0, 8)}@${RP_ID}`);
  });

  test("label を渡すとそれが displayName になり、credentials に保存される", async () => {
    const res = await post("/auth/register/options", { label: "仕事用ノート PC" });
    const options = (await res.json()) as {
      challenge: string;
      user: { name: string; displayName: string };
    };
    expect(options.user.displayName).toBe("仕事用ノート PC");
    expect(options.user.name).not.toBe("仕事用ノート PC");

    const payload = await authenticator.attest({ challenge: options.challenge, origin: RP_ORIGIN });
    expect((await post("/auth/register/verify", payload)).status).toBe(200);
    const stored = await db.select().from(credentials);
    expect(stored[0]?.displayName).toBe("仕事用ノート PC");
  });

  test("表示名の無い既存クレデンシャルでもログイン・一覧が壊れない（列は nullable）", async () => {
    const account = await registerAccount();
    // この列より前に登録された行を模して NULL に戻す
    await db.update(credentials).set({ displayName: null });

    const listed = await listCredentials(account.token);
    expect(listed[0]?.displayName).toBeNull();
    const assertion = await authenticator.assert({
      challenge: await loginChallenge(),
      origin: RP_ORIGIN,
      counter: 1,
    });
    expect((await post("/auth/login/verify", assertion)).status).toBe(200);
  });
});
