import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountDatabases, accountIdentities, accounts } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { databaseNameForAccount } from "@zakki/api/turso/provision.ts";
import { createTursoPlatform } from "@zakki/core/turso/platform.ts";
import { createFakePlatformApi } from "@zakki/core/turso/test-fixtures.ts";
import { relinkIdentities } from "./relink-identity.ts";

/**
 * パスキー時代のアカウントを OIDC の identity に結び直す（OIDC 移行の一度きりの運用）。
 *
 * 移行後に Google でログインすると、既存アカウントとは別の新しいアカウント（from）が
 * できる。その identity を既存アカウント（to）へ付け替え、from は DB ごと消す。
 * 台帳は本物の libSQL、Platform API だけ fake。
 */

const ORG = "zakki-org";
const API_TOKEN = "org-scoped-token";
const MIGRATIONS = join(import.meta.dir, "..", "drizzle");
const NOW = "2026-09-19T00:00:00.000Z";

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
  const path = join(mkdtempSync(join(tmpdir(), "zakki-relink-")), "control.sqlite");
  const client = createClient({ url: `file:${path}` });
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え
  db = drizzle(client, { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  // 本番（Turso）と同じく FK 強制を切る。cascade に頼る実装だとテストでだけ通ってしまう
  await client.execute("PRAGMA foreign_keys = OFF");

  fake.state.databases.clear();
  fake.state.deleteRequests.length = 0;
  fake.state.deleteStatus = null;
});

/** パスキー時代の既存アカウント（identity なし・DB あり） */
async function seedLegacyAccount(): Promise<string> {
  const accountId = crypto.randomUUID();
  const dbName = await databaseNameForAccount(accountId);
  await db.insert(accounts).values({ id: accountId, createdAt: NOW });
  await db.insert(accountDatabases).values({
    accountId,
    dbName,
    dbHostname: `${dbName}-${ORG}.aws-ap-northeast-1.turso.io`,
    createdAt: NOW,
  });
  fake.state.databases.set(dbName, `${dbName}-${ORG}.aws-ap-northeast-1.turso.io`);
  return accountId;
}

/** 移行後の Google ログインで新しくできたアカウント（identity あり・DB も作られている） */
async function seedFreshOidcAccount(subject: string): Promise<string> {
  const accountId = await seedLegacyAccount();
  await db.insert(accountIdentities).values({
    provider: "google",
    subject,
    accountId,
    email: `${subject}@example.com`,
    createdAt: NOW,
  });
  return accountId;
}

describe("relinkIdentities", () => {
  test("from の identity が to へ移り、from はアカウントも DB も消える", async () => {
    const legacy = await seedLegacyAccount();
    const fresh = await seedFreshOidcAccount("sub-1");
    const freshDb = await databaseNameForAccount(fresh);

    const result = await relinkIdentities(db, platform, { from: fresh, to: legacy });

    expect(result._unsafeUnwrap()).toEqual({ moved: 1 });
    const identities = await db.select().from(accountIdentities);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.accountId).toBe(legacy);
    expect(await db.select().from(accounts).where(eq(accounts.id, fresh))).toEqual([]);
    expect(
      await db.select().from(accountDatabases).where(eq(accountDatabases.accountId, fresh)),
    ).toEqual([]);
    expect(fake.state.deleteRequests).toEqual([freshDb]);
    // to（既存アカウント）の DB には触らない
    expect(fake.state.databases.has(await databaseNameForAccount(legacy))).toBe(true);
    expect(await db.select().from(accounts).where(eq(accounts.id, legacy))).toHaveLength(1);
  });

  test("to が存在しなければ失敗し、何も変えない", async () => {
    const fresh = await seedFreshOidcAccount("sub-1");

    const result = await relinkIdentities(db, platform, { from: fresh, to: "no-such-account" });

    expect(result._unsafeUnwrapErr().kind).toBe("unknown-target");
    expect((await db.select().from(accountIdentities))[0]?.accountId).toBe(fresh);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(fake.state.deleteRequests).toEqual([]);
  });

  test("from が存在しなければ失敗し、何も変えない", async () => {
    const legacy = await seedLegacyAccount();

    const result = await relinkIdentities(db, platform, { from: "no-such-account", to: legacy });

    expect(result._unsafeUnwrapErr().kind).toBe("unknown-source");
    expect(fake.state.deleteRequests).toEqual([]);
  });

  test("from と to が同じなら失敗する（自分自身を消さない）", async () => {
    const fresh = await seedFreshOidcAccount("sub-1");

    const result = await relinkIdentities(db, platform, { from: fresh, to: fresh });

    expect(result._unsafeUnwrapErr().kind).toBe("same-account");
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(fake.state.deleteRequests).toEqual([]);
  });

  test("from の DB 削除に失敗しても identity は移っており、再実行で完了する", async () => {
    const legacy = await seedLegacyAccount();
    const fresh = await seedFreshOidcAccount("sub-1");
    fake.state.deleteStatus = 500;

    const failed = await relinkIdentities(db, platform, { from: fresh, to: legacy });
    expect(failed._unsafeUnwrapErr().kind).toBe("delete-failed");
    // ログインは既に既存アカウントへ向く（from に入る経路は残らない）
    expect((await db.select().from(accountIdentities))[0]?.accountId).toBe(legacy);

    fake.state.deleteStatus = null;
    const retried = await relinkIdentities(db, platform, { from: fresh, to: legacy });
    expect(retried._unsafeUnwrap()).toEqual({ moved: 0 });
    expect(await db.select().from(accounts).where(eq(accounts.id, fresh))).toEqual([]);
  });
});
