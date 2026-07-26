import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { accountDatabases, accounts, credentials } from "./schema.ts";

/**
 * コントロールプレーン DB スキーマの検証（issue #99）。
 * drizzle-kit 生成の migration（apps/api/drizzle/）を本物の libsql に適用し、
 * schema.ts のクエリと突き合わせる（migration と schema のドリフトはここで割れる）。
 * 本番適用はデプロイ時（Workers では migrate しない）。
 */

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

async function openControlDb() {
  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  // （packages/data/src/db/connect.ts の toLibsqlUrl と同じ理由）
  const path = join(mkdtempSync(join(tmpdir(), "zakki-control-")), "control.sqlite");
  const client = createClient({ url: `file:${path}` });
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema: { accounts, credentials, accountDatabases } });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { client, db };
}

const NOW = "2026-07-26T00:00:00.000Z";

describe("コントロールプレーン DB スキーマ", () => {
  test("accounts / credentials / account_databases に書いて読める", async () => {
    const { db } = await openControlDb();
    await db.insert(accounts).values({ id: "acc-1", createdAt: NOW });
    await db.insert(credentials).values({
      credentialId: "cred-1",
      accountId: "acc-1",
      publicKey: "pQECAyY", // COSE 公開鍵の base64url（形式のみ）
      counter: 0,
      transports: JSON.stringify(["internal"]),
      createdAt: NOW,
    });
    await db.insert(accountDatabases).values({
      accountId: "acc-1",
      dbName: "zakki-user-acc-1",
      dbHostname: "zakki-user-acc-1.example.turso.io",
      createdAt: NOW,
    });

    const cred = await db.select().from(credentials).where(eq(credentials.accountId, "acc-1"));
    expect(cred).toEqual([
      {
        credentialId: "cred-1",
        accountId: "acc-1",
        publicKey: "pQECAyY",
        counter: 0,
        transports: JSON.stringify(["internal"]),
        // 表示名（issue #118）は nullable。未設定でも行は成立する
        displayName: null,
        createdAt: NOW,
      },
    ]);
    const ledger = await db.select().from(accountDatabases);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.dbHostname).toBe("zakki-user-acc-1.example.turso.io");
  });

  test("アカウント削除で credentials / account_databases が cascade で消える", async () => {
    const { db } = await openControlDb();
    await db.insert(accounts).values({ id: "acc-1", createdAt: NOW });
    await db.insert(credentials).values({
      credentialId: "cred-1",
      accountId: "acc-1",
      publicKey: "pQECAyY",
      counter: 0,
      createdAt: NOW,
    });
    await db.insert(accountDatabases).values({
      accountId: "acc-1",
      dbName: "db",
      dbHostname: "db.example.turso.io",
      createdAt: NOW,
    });

    await db.delete(accounts).where(eq(accounts.id, "acc-1"));
    expect(await db.select().from(credentials)).toEqual([]);
    expect(await db.select().from(accountDatabases)).toEqual([]);
  });

  test("account_databases は所在のみを持つ（本文・鍵・DEK の列を持たない = E2E）", async () => {
    const { client } = await openControlDb();
    const info = await client.execute("PRAGMA table_info(account_databases)");
    const columns = info.rows
      .map((row) => row["name"])
      .filter((name): name is string => typeof name === "string")
      .sort((a, b) => a.localeCompare(b));
    expect(columns).toEqual(["account_id", "created_at", "db_hostname", "db_name"]);
  });
});
