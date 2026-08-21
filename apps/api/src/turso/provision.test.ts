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
import { databaseNameForAccount, ensureUserDatabase } from "@zakki/api/turso/provision.ts";
import { createTursoPlatform, TURSO_DEFAULT_LOCATION } from "@zakki/core/turso/platform.ts";
import { createFakePlatformApi } from "@zakki/core/turso/test-fixtures.ts";

/**
 * プロビジョニングと Turso リソースの生成順の検証（issue #130）。
 *
 * DB は必ず group に属するため、group を持たない組織では DB 作成が失敗する。
 * Pulumi をやめて group もアプリ側で作るようになった（issue #129）ので、
 * 「台帳を引く → group を存在させる → DB を作る → 台帳へ書く」の順が壊れていない
 * ことをここで縛る。HTTP 経路込みの検証は routes/me.test.ts にある。
 *
 * コントロールプレーン DB は本物の libSQL、Platform API だけ fake（プロトコル
 * レベル）に差し替える。クライアントのメソッドは mock しない。
 */

const ORG = "zakki-org";
const GROUP = "zakki-group";
const API_TOKEN = "platform-api-token";
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

/** group を 1 つも持たない組織から始める（本番の「空の組織」と同条件） */
const fake = createFakePlatformApi({ organization: ORG, apiToken: API_TOKEN });
const server = Bun.serve({ port: 0, fetch: fake.app.fetch });
const platform = createTursoPlatform({
  baseUrl: `http://127.0.0.1:${server.port}`,
  apiToken: API_TOKEN,
  organization: ORG,
  group: GROUP,
});

afterAll(() => {
  void server.stop(true);
});

let db: ControlDb;

beforeEach(async () => {
  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  const path = join(mkdtempSync(join(tmpdir(), "zakki-provision-")), "control.sqlite");
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え（他の apps/api テストと同じ）
  db = drizzle(createClient({ url: `file:${path}` }), { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });

  fake.state.groups.clear();
  fake.state.createGroupRequests.length = 0;
  fake.state.databases.clear();
  fake.state.createRequests.length = 0;
  fake.state.getGroupStatus = null;
  fake.state.createGroupStatus = null;
  fake.state.createStatus = null;
});

/** 登録済みアカウントを 1 つ作る（台帳は accounts への FK を持つ） */
async function newAccount(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(accounts).values({ id, createdAt: new Date().toISOString() });
  return id;
}

describe("ensureUserDatabase の group 存在保証（issue #130）", () => {
  test("group が 1 つも無い組織でも、group を作ってから DB を作る", async () => {
    const accountId = await newAccount();
    const result = await ensureUserDatabase(db, platform, accountId, Date.now());

    expect(result.isOk()).toBe(true);
    // 現行 API が受け付けるのは AWS リージョン形式のロケーションだけ
    // （旧 3 文字コード `nrt` は 400 invalid location。2026-08-19 実測, issue #129）
    expect(fake.state.createGroupRequests).toEqual([
      { name: GROUP, location: TURSO_DEFAULT_LOCATION },
    ]);
    expect(fake.state.createRequests).toEqual([
      { name: await databaseNameForAccount(accountId), group: GROUP },
    ]);
  });

  test("2 人目のアカウントでも group を作り直さない", async () => {
    const now = Date.now();
    expect((await ensureUserDatabase(db, platform, await newAccount(), now)).isOk()).toBe(true);
    expect((await ensureUserDatabase(db, platform, await newAccount(), now)).isOk()).toBe(true);

    expect(fake.state.createGroupRequests).toHaveLength(1);
    expect(fake.state.databases.size).toBe(2);
  });

  test("group を用意できなければ DB 作成へ進まず、台帳も汚さない", async () => {
    fake.state.createGroupStatus = 500;

    const result = await ensureUserDatabase(db, platform, await newAccount(), Date.now());

    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "status", status: 500 });
    expect(fake.state.createRequests).toEqual([]);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });

  test("台帳ヒット時は group にも DB にも触らない", async () => {
    const accountId = await newAccount();
    expect((await ensureUserDatabase(db, platform, accountId, Date.now())).isOk()).toBe(true);
    fake.state.createGroupRequests.length = 0;
    fake.state.createRequests.length = 0;
    // 次に Platform API を叩けば必ず失敗する状態にしておく
    fake.state.getGroupStatus = 500;

    const again = await ensureUserDatabase(db, platform, accountId, Date.now());

    expect(again.isOk()).toBe(true);
    expect(fake.state.createGroupRequests).toEqual([]);
    expect(fake.state.createRequests).toEqual([]);
  });
});
