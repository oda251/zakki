import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { findPrimaryIdentity } from "./identities.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountIdentities, accounts } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";

/**
 * issue #159: アカウント表示用の主 identity の解決。
 * 「主は 高々 1 つ」は部分一意インデックスが守るが、「主が 0 件」は防げないので、
 * その場合のフォールバック（最も古い作成の identity を主とみなす）を検証する。
 */

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

const NOW = "2026-07-26T00:00:00.000Z";

let db: ControlDb;

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), "zakki-ident-")), "control.sqlite");
  const client = createClient({ url: `file:${path}` });
  db = drizzle(client, { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(accounts).values({ id: "acc-1", createdAt: NOW });
});

describe("findPrimaryIdentity", () => {
  test("I1: 主 identity があればそれを返す", async () => {
    await db.insert(accountIdentities).values([
      {
        provider: "google",
        subject: "sub-old",
        accountId: "acc-1",
        email: "old@example.com",
        isPrimary: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        provider: "github",
        subject: "sub-new",
        accountId: "acc-1",
        email: "new@example.com",
        isPrimary: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    expect(await findPrimaryIdentity(db, "acc-1")).toEqual({
      providerId: "github",
      email: "new@example.com",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  });

  test("I2: 主が 0 件なら最も古く作られた identity を主とみなす", async () => {
    await db.insert(accountIdentities).values([
      {
        provider: "google",
        subject: "sub-old",
        accountId: "acc-1",
        email: "old@example.com",
        isPrimary: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        provider: "github",
        subject: "sub-new",
        accountId: "acc-1",
        email: "new@example.com",
        isPrimary: 0,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    expect(await findPrimaryIdentity(db, "acc-1")).toEqual({
      providerId: "google",
      email: "old@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("I3: identity が無いアカウントは null", async () => {
    expect(await findPrimaryIdentity(db, "acc-1")).toBeNull();
    expect(await findPrimaryIdentity(db, "no-such-account")).toBeNull();
  });
});