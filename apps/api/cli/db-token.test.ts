import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountDatabases, accounts } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/core/turso/platform.ts";
import { createFakePlatformApi } from "@zakki/core/turso/test-fixtures.ts";
import { parseDbTokenEnv } from "./env.ts";
import { issueLongLivedToken, lookupAccountDatabase } from "./db-token.ts";

/**
 * TUI 用の長命トークン発行（issue #135）。
 *
 * TUI と web が同じ DB を見るための接続情報を、台帳（コントロールプレーン DB）と
 * Platform API から組み立てる。台帳は本物の libSQL、Platform API だけ fake。
 */

const ORG = "zakki-org";
const API_TOKEN = "org-scoped-token";
const MIGRATIONS = join(import.meta.dir, "..", "drizzle");

const fake = createFakePlatformApi({ organization: ORG, apiToken: API_TOKEN });
const server = Bun.serve({ port: 0, fetch: fake.app.fetch });
const platform = createTursoPlatform({
  baseUrl: `http://127.0.0.1:${server.port}`,
  apiToken: API_TOKEN,
  organization: ORG,
  group: "zakki",
});

afterAll(() => {
  void server.stop(true);
});

let db: ControlDb;

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zakki-dbtoken-")), "control.sqlite");
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え
  db = drizzle(createClient({ url: `file:${path}` }), { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });

  fake.state.databases.clear();
  fake.state.tokenRequests.length = 0;
  fake.state.tokenStatus = null;
});

/** 台帳に「ブラウザで一度ログイン済み」の状態を作る */
async function seedAccount(dbName: string): Promise<string> {
  const accountId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(accounts).values({ id: accountId, createdAt: now });
  await db.insert(accountDatabases).values({
    accountId,
    dbName,
    dbHostname: `${dbName}-${ORG}.aws-ap-northeast-1.turso.io`,
    createdAt: now,
  });
  fake.state.databases.set(dbName, `${dbName}-${ORG}.aws-ap-northeast-1.turso.io`);
  return accountId;
}

describe("lookupAccountDatabase", () => {
  test("アカウントが 1 つだけなら accountId 省略で引ける", async () => {
    const accountId = await seedAccount("zakki-u-aaa");

    const found = (await lookupAccountDatabase(db, undefined))._unsafeUnwrap();

    expect(found.accountId).toBe(accountId);
    expect(found.dbName).toBe("zakki-u-aaa");
  });

  test("accountId 指定でその行を引く", async () => {
    await seedAccount("zakki-u-aaa");
    const second = await seedAccount("zakki-u-bbb");

    const found = (await lookupAccountDatabase(db, second))._unsafeUnwrap();

    expect(found.dbName).toBe("zakki-u-bbb");
  });

  test("複数あって accountId 省略なら、選ばずに候補を返して止まる", async () => {
    const first = await seedAccount("zakki-u-aaa");
    const second = await seedAccount("zakki-u-bbb");

    const failure = (await lookupAccountDatabase(db, undefined))._unsafeUnwrapErr();

    expect(failure.kind).toBe("ambiguous");
    if (failure.kind !== "ambiguous") throw new Error("ambiguous のはず");
    expect([...failure.accountIds].sort()).toEqual([first, second].sort());
  });

  test("台帳が空なら empty（まだブラウザでログインしていない）", async () => {
    expect((await lookupAccountDatabase(db, undefined))._unsafeUnwrapErr().kind).toBe("empty");
  });

  test("知らない accountId は not-found", async () => {
    await seedAccount("zakki-u-aaa");
    expect((await lookupAccountDatabase(db, "no-such"))._unsafeUnwrapErr().kind).toBe("not-found");
  });
});

describe("issueLongLivedToken", () => {
  test("既定は無期限・full-access（TUI が常用する接続）", async () => {
    await seedAccount("zakki-u-aaa");

    const token = await issueLongLivedToken(platform, "zakki-u-aaa", "never");

    expect(token._unsafeUnwrap()).toBe("token-for-zakki-u-aaa-1");
    expect(fake.state.tokenRequests).toEqual([
      { name: "zakki-u-aaa", expiration: "never", authorization: "full-access" },
    ]);
  });

  test("期限を指定できる（DB_TOKEN_EXPIRATION）", async () => {
    await seedAccount("zakki-u-aaa");

    expect((await issueLongLivedToken(platform, "zakki-u-aaa", "12w")).isOk()).toBe(true);

    expect(fake.state.tokenRequests[0]?.expiration).toBe("12w");
  });

  test("発行に失敗したらそのまま失敗を返す", async () => {
    await seedAccount("zakki-u-aaa");
    fake.state.tokenStatus = 500;

    const token = await issueLongLivedToken(platform, "zakki-u-aaa", "never");

    expect(token._unsafeUnwrapErr()).toMatchObject({ kind: "status", status: 500 });
  });
});

describe("parseDbTokenEnv", () => {
  test("必須 4 つが揃えば既定の期限は never", () => {
    const config = parseDbTokenEnv({
      TURSO_API_TOKEN: "tok",
      TURSO_ORG: ORG,
      CONTROL_DB_URL: "libsql://control.example.turso.io",
      CONTROL_DB_TOKEN: "control-tok",
    })._unsafeUnwrap();

    expect(config.expiration).toBe("never");
  });

  test("コントロールプレーンの接続情報が無ければ、どれが足りないかを示す", () => {
    const result = parseDbTokenEnv({ TURSO_API_TOKEN: "tok", TURSO_ORG: ORG });
    expect(result._unsafeUnwrapErr()).toContain("CONTROL_DB_URL");
  });
});
