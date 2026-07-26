import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createApp } from "@zakki/api/app.ts";
import { createSoftAuthenticator } from "@zakki/api/auth/test-fixtures.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountDatabases, accounts, credentials } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/api/turso/platform.ts";
import { databaseNameForAccount } from "@zakki/api/turso/provision.ts";
import { createFakePlatformApi } from "@zakki/api/turso/test-fixtures.ts";

/**
 * ユーザごと Turso DB のプロビジョニング（issue #101）と退会（issue #116）の統合検証。
 *
 * fetch ハンドラを直叩きし、コントロールプレーン DB は本物の libsql、認証は #100 の
 * ソフトウェア認証器で実際に登録してセッションを得る。ローカルで再現できないのは
 * Turso Platform API だけなので、そこだけを**プロトコルレベル**で差し替える:
 * fake（turso/test-fixtures.ts）を Bun.serve で立て、クライアントの base URL を
 * そこへ向ける。クライアントのメソッドは mock しない。
 */

const RP_ID = "zakki.test";
const RP_ORIGIN = "https://zakki.test";
const SESSION_SECRET = "test-session-secret";
const ORG = "zakki-org";
const GROUP = "zakki-group";
const API_TOKEN = "platform-api-token";
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

const fake = createFakePlatformApi({ organization: ORG, apiToken: API_TOKEN, group: GROUP });
const server = Bun.serve({ port: 0, fetch: fake.app.fetch });
const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

let db: ControlDb;
let app: ReturnType<typeof createApp>;

function makeApp(platformBaseUrl: string): ReturnType<typeof createApp> {
  return createApp({
    db,
    auth: { rpId: RP_ID, rpOrigin: RP_ORIGIN, sessionSecret: SESSION_SECRET },
    turso: createTursoPlatform({
      baseUrl: platformBaseUrl,
      apiToken: API_TOKEN,
      organization: ORG,
      group: GROUP,
    }),
  });
}

beforeEach(async () => {
  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  const path = join(mkdtempSync(join(tmpdir(), "zakki-medb-")), "control.sqlite");
  db = drizzle(createClient({ url: `file:${path}` }), { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });

  fake.state.databases.clear();
  fake.state.createRequests.length = 0;
  fake.state.tokenRequests.length = 0;
  fake.state.deleteRequests.length = 0;
  fake.state.createStatus = null;
  fake.state.getStatus = null;
  fake.state.tokenStatus = null;
  fake.state.deleteStatus = null;
  fake.state.malformedCreate = false;

  app = makeApp(baseUrl);
});

/** パスキーを登録してセッションを得る（#100 の経路をそのまま通す） */
async function login(): Promise<{ accountId: string; token: string }> {
  const authenticator = await createSoftAuthenticator(RP_ID);
  const optionsRes = await app.fetch(
    new Request("https://control.test/auth/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  const { challenge } = (await optionsRes.json()) as { challenge: string };
  const payload = await authenticator.attest({ challenge, origin: RP_ORIGIN });
  const res = await app.fetch(
    new Request("https://control.test/auth/register/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { accountId: string; token: string };
}

async function getDb(token?: string): Promise<Response> {
  return app.fetch(
    new Request("https://control.test/me/db", {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}

/** 退会（#116）。対象はセッションの持ち主自身で、相手を指定する引数は無い */
async function deleteMe(token?: string): Promise<Response> {
  return app.fetch(
    new Request("https://control.test/me", {
      method: "DELETE",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );
}

/** `GET /auth/me`（中継サーバが「あなたは誰か」を解決するのに使う経路） */
async function authMe(token: string): Promise<Response> {
  return app.fetch(
    new Request("https://control.test/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

interface DbResponse {
  dbUrl: string;
  token: string;
  expiresAt: number;
}

describe("databaseNameForAccount", () => {
  test("accountId から決定的に導かれ、Turso の命名規則に収まる", async () => {
    const accountId = crypto.randomUUID();
    const name = await databaseNameForAccount(accountId);
    expect(name).toMatch(/^zakki-u-[0-9a-f]{32}$/);
    expect(name.length).toBeLessThanOrEqual(64);
    // 同じ accountId なら常に同じ名前（＝再試行で同じ DB を引き当てられる）
    expect(await databaseNameForAccount(accountId)).toBe(name);
  });

  test("アカウントが違えば名前も違い、accountId 自体は名前に現れない", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(await databaseNameForAccount(a)).not.toBe(await databaseNameForAccount(b));
    // ホスト名は DNS / TLS SNI に出るのでアカウント識別子を平文で載せない
    expect(await databaseNameForAccount(a)).not.toContain(a.replaceAll("-", ""));
  });
});

describe("GET /me/db（初回）", () => {
  test("DB を作成し台帳へ記録して dbUrl と短命トークンを返す", async () => {
    const session = await login();
    const before = Date.now();
    const res = await getDb(session.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DbResponse;

    const name = await databaseNameForAccount(session.accountId);
    expect(body.dbUrl).toBe(`libsql://${name}-${ORG}.turso.io`);
    expect(body.token).toBe(`token-for-${name}-1`);
    // 短命トークン: 1 時間先に失効する（epoch 秒、セッションと同じ単位）
    expect(body.expiresAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) + 3600);
    expect(body.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);

    // Platform API へは設定の group で 1 度だけ作成を投げる
    expect(fake.state.createRequests).toEqual([{ name, group: GROUP }]);
    // トークンは期限つき・full-access（既定の never を使わせない）
    expect(fake.state.tokenRequests).toEqual([
      { name, expiration: "60m", authorization: "full-access" },
    ]);
  });

  test("台帳には DB の所在だけが載り、トークン・鍵の類は一切保存しない", async () => {
    const session = await login();
    const body = (await (await getDb(session.token)).json()) as DbResponse;

    const rows = await db.select().from(accountDatabases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(session.accountId);
    expect(rows[0]?.dbName).toBe(await databaseNameForAccount(session.accountId));
    expect(rows[0]?.dbHostname).toBe(`${rows[0]?.dbName}-${ORG}.turso.io`);
    // 発行したトークンも Platform API トークンも台帳のどこにも現れない
    expect(JSON.stringify(rows)).not.toContain(body.token);
    expect(JSON.stringify(rows)).not.toContain(API_TOKEN);
  });

  test("アカウントごとに別の DB が作られる", async () => {
    const first = await login();
    const second = await login();
    expect((await getDb(first.token)).status).toBe(200);
    expect((await getDb(second.token)).status).toBe(200);

    expect(fake.state.createRequests).toHaveLength(2);
    expect(fake.state.createRequests[0]?.name).not.toBe(fake.state.createRequests[1]?.name);
    expect(await db.select().from(accountDatabases)).toHaveLength(2);
  });
});

describe("GET /me/db（2 回目以降）", () => {
  test("台帳ヒット時は DB 作成 API を叩かず、トークンだけを都度発行する", async () => {
    const session = await login();
    const first = (await (await getDb(session.token)).json()) as DbResponse;

    const res = await getDb(session.token);
    expect(res.status).toBe(200);
    const second = (await res.json()) as DbResponse;

    expect(second.dbUrl).toBe(first.dbUrl);
    // 作成は初回の 1 度きり
    expect(fake.state.createRequests).toHaveLength(1);
    // トークンは毎回新しく発行する（保存も使い回しもしない）
    expect(fake.state.tokenRequests).toHaveLength(2);
    expect(second.token).not.toBe(first.token);
    expect(await db.select().from(accountDatabases)).toHaveLength(1);
  });
});

describe("GET /me/db の冪等性", () => {
  test("DB 作成後・台帳書き込み前に落ちた再試行で二重作成しない（already exists を畳む）", async () => {
    const session = await login();
    const name = await databaseNameForAccount(session.accountId);
    // 前回の試行が残した状態: Turso には DB があるが台帳は空
    fake.state.databases.set(name, `${name}-${ORG}.turso.io`);
    expect(await db.select().from(accountDatabases)).toEqual([]);

    const res = await getDb(session.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DbResponse;
    expect(body.dbUrl).toBe(`libsql://${name}-${ORG}.turso.io`);

    // 作成は 409 で弾かれ、新しい DB は増えていない
    expect(fake.state.createRequests).toEqual([{ name, group: GROUP }]);
    expect(fake.state.databases.size).toBe(1);
    // 台帳は既存 DB を指して 1 行だけ書かれる
    const rows = await db.select().from(accountDatabases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dbName).toBe(name);
  });

  test("already exists の直後に DB を引けなければ 502（作り直して他人の DB を踏まない）", async () => {
    const session = await login();
    const name = await databaseNameForAccount(session.accountId);
    fake.state.databases.set(name, `${name}-${ORG}.turso.io`);
    fake.state.getStatus = 500;

    const res = await getDb(session.token);
    expect(res.status).toBe(502);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });
});

describe("GET /me/db の異常系", () => {
  test("Authorization ヘッダが無ければ 401（Platform API を一切叩かない）", async () => {
    const res = await getDb();
    expect(res.status).toBe(401);
    expect(fake.state.createRequests).toEqual([]);
  });

  test("署名の壊れたセッションは 401", async () => {
    const session = await login();
    const res = await getDb(`${session.token.slice(0, -2)}xy`);
    expect(res.status).toBe(401);
    expect(fake.state.createRequests).toEqual([]);
  });

  test("DB 作成が Platform API 側で失敗したら 502（台帳を汚さない）", async () => {
    const session = await login();
    fake.state.createStatus = 500;

    const res = await getDb(session.token);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "データベースを準備できませんでした" });
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });

  test("Platform API へ到達できなければ 502", async () => {
    const session = await login();
    app = makeApp("http://127.0.0.1:1");

    const res = await getDb(session.token);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "データベースを準備できませんでした" });
  });

  test("作成レスポンスの形が想定と違えば 502（壊れた値を台帳に書かない）", async () => {
    const session = await login();
    fake.state.malformedCreate = true;

    const res = await getDb(session.token);
    expect(res.status).toBe(502);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });

  test("トークン発行が失敗したら 502（DB は用意済みなので次回は作成せず再試行できる）", async () => {
    const session = await login();
    fake.state.tokenStatus = 500;

    const res = await getDb(session.token);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "データベーストークンを発行できませんでした" });
    // 台帳には書けているので、再試行はトークン発行からやり直しになる
    expect(await db.select().from(accountDatabases)).toHaveLength(1);

    fake.state.tokenStatus = null;
    expect((await getDb(session.token)).status).toBe(200);
    expect(fake.state.createRequests).toHaveLength(1);
  });

  test("Platform API トークンが違えば 401 を受けて 502（組織スコープの認証を実際に通す）", async () => {
    const session = await login();
    app = createApp({
      db,
      auth: { rpId: RP_ID, rpOrigin: RP_ORIGIN, sessionSecret: SESSION_SECRET },
      turso: createTursoPlatform({
        baseUrl,
        apiToken: "wrong-token",
        organization: ORG,
        group: GROUP,
      }),
    });

    const res = await getDb(session.token);
    expect(res.status).toBe(502);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });
});

describe("DELETE /me（退会, issue #116）", () => {
  test("Turso の DB・台帳・アカウント・クレデンシャルがすべて消える", async () => {
    const session = await login();
    expect((await getDb(session.token)).status).toBe(200);
    const name = await databaseNameForAccount(session.accountId);
    // 消す前: DB も台帳もクレデンシャルも在る
    expect(fake.state.databases.has(name)).toBe(true);
    expect(await db.select().from(credentials)).toHaveLength(1);

    const res = await deleteMe(session.token);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // Turso 側は台帳が指していた DB をちょうど 1 度消しに行く
    expect(fake.state.deleteRequests).toEqual([name]);
    expect(fake.state.databases.size).toBe(0);
    // コントロールプレーン側は accounts の削除だけで cascade する（db/schema.ts）
    expect(await db.select().from(accounts)).toEqual([]);
    expect(await db.select().from(credentials)).toEqual([]);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });

  test("`GET /me/db` を一度も叩いていなくても退会できる（台帳が空でも 204）", async () => {
    const session = await login();
    expect(await db.select().from(accountDatabases)).toEqual([]);

    const res = await deleteMe(session.token);
    expect(res.status).toBe(204);
    // 実在しない DB の削除は 404 → 成功に畳む（冪等）
    expect(fake.state.deleteRequests).toEqual([await databaseNameForAccount(session.accountId)]);
    expect(await db.select().from(accounts)).toEqual([]);
  });

  test("台帳に載っていない孤児 DB（作成後・台帳書き込み前に落ちた残骸）も消す", async () => {
    const session = await login();
    const name = await databaseNameForAccount(session.accountId);
    // プロビジョニングが「DB 作成 → 台帳書き込み」の間で落ちた状態
    fake.state.databases.set(name, `${name}-${ORG}.turso.io`);
    expect(await db.select().from(accountDatabases)).toEqual([]);

    expect((await deleteMe(session.token)).status).toBe(204);
    // 名前は accountId から決定的に導けるので、台帳が無くても消しに行ける
    expect(fake.state.deleteRequests).toEqual([name]);
    expect(fake.state.databases.size).toBe(0);
  });
});

describe("DELETE /me の異常系（孤児 DB を作らない）", () => {
  test("DB 削除が失敗したら 502。台帳は残り、再試行で完了できる", async () => {
    const session = await login();
    expect((await getDb(session.token)).status).toBe(200);
    const name = await databaseNameForAccount(session.accountId);
    fake.state.deleteStatus = 500;

    const res = await deleteMe(session.token);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "アカウントを削除できませんでした" });
    // 台帳を先に消していたら DB 名の出どころが消え、この DB は誰も消せなくなる
    const ledger = await db.select().from(accountDatabases);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.dbName).toBe(name);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(fake.state.databases.has(name)).toBe(true);

    // 上流が復旧すれば同じリクエストの再送で退会が完了する
    fake.state.deleteStatus = null;
    expect((await deleteMe(session.token)).status).toBe(204);
    expect(fake.state.deleteRequests).toEqual([name, name]);
    expect(fake.state.databases.size).toBe(0);
    expect(await db.select().from(accounts)).toEqual([]);
    expect(await db.select().from(credentials)).toEqual([]);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });

  test("Platform API へ到達できなければ 502（台帳・アカウントを残す）", async () => {
    const session = await login();
    expect((await getDb(session.token)).status).toBe(200);
    app = makeApp("http://127.0.0.1:1");

    expect((await deleteMe(session.token)).status).toBe(502);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(accountDatabases)).toHaveLength(1);
  });

  test("Authorization ヘッダが無ければ 401（Platform API を一切叩かない）", async () => {
    const session = await login();
    expect((await getDb(session.token)).status).toBe(200);

    expect((await deleteMe()).status).toBe(401);
    expect(fake.state.deleteRequests).toEqual([]);
    expect(await db.select().from(accounts)).toHaveLength(1);
  });

  test("署名の壊れたセッションでは削除できない", async () => {
    const session = await login();
    expect((await deleteMe(`${session.token.slice(0, -2)}xy`)).status).toBe(401);
    expect(fake.state.deleteRequests).toEqual([]);
    expect(await db.select().from(accounts)).toHaveLength(1);
  });

  test("他アカウントを指定して消す経路が無い（対象は常にセッションの持ち主）", async () => {
    const victim = await login();
    const attacker = await login();
    expect((await getDb(victim.token)).status).toBe(200);
    expect((await getDb(attacker.token)).status).toBe(200);

    // 相手を指定できそうなパスはどれもルートに存在しない
    for (const path of [`/me/${victim.accountId}`, `/me/db/${victim.accountId}`, "/me/accounts"]) {
      const res = await app.fetch(
        new Request(`https://control.test${path}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${attacker.token}` },
        }),
      );
      expect(res.status).toBe(404);
    }
    // 本文で相手を指定しても無視され、消えるのは攻撃者自身
    const res = await app.fetch(
      new Request("https://control.test/me", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${attacker.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: victim.accountId }),
      }),
    );
    expect(res.status).toBe(204);

    expect(fake.state.deleteRequests).toEqual([await databaseNameForAccount(attacker.accountId)]);
    const remaining = await db.select().from(accounts);
    expect(remaining.map((row) => row.id)).toEqual([victim.accountId]);
    expect(fake.state.databases.has(await databaseNameForAccount(victim.accountId))).toBe(true);
  });
});

describe("退会後の生き残りセッション（issue #116。恒久的な失効機構は #117）", () => {
  test("同じ JWT で `GET /me/db` を叩いても 401。DB は再生成されない", async () => {
    const session = await login();
    expect((await getDb(session.token)).status).toBe(200);
    expect((await deleteMe(session.token)).status).toBe(204);

    const createsBefore = fake.state.createRequests.length;
    const res = await getDb(session.token);
    // 署名としては有効なままのトークン（ステートレス JWT）だが、accounts に
    // 居ないので通さない。これが無いと ensureUserDatabase が DB を作り直す
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "セッションが無効です" });
    expect(fake.state.createRequests).toHaveLength(createsBefore);
    expect(fake.state.databases.size).toBe(0);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });

  test("同じ JWT で `GET /auth/me` を叩いても 401（中継サーバの解決が失敗する）", async () => {
    const session = await login();
    expect((await authMe(session.token)).status).toBe(200);

    expect((await deleteMe(session.token)).status).toBe(204);
    expect((await authMe(session.token)).status).toBe(401);
  });

  test("二重の退会は 401（Platform API を二度叩かない）", async () => {
    const session = await login();
    expect((await deleteMe(session.token)).status).toBe(204);
    expect(fake.state.deleteRequests).toHaveLength(1);

    expect((await deleteMe(session.token)).status).toBe(401);
    expect(fake.state.deleteRequests).toHaveLength(1);
  });

  test("退会済みアカウントのパスキーは残らない（クレデンシャルごと消えている）", async () => {
    const session = await login();
    expect((await deleteMe(session.token)).status).toBe(204);
    expect(await db.select().from(credentials)).toEqual([]);
  });
});
