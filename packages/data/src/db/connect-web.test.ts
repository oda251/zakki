import { beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { migrateWebDb } from "@zakki/data/db/connect-web.ts";
import * as schema from "@zakki/data/db/schema.ts";

/**
 * 埋め込み migration の適用（issue #134）。
 *
 * Workers では drizzle の migrator（node:fs でファイルを読む）が使えないので、
 * SQL をソースに埋め込んだ経路を用意した。**node 側と同じ状態に収束すること**が
 * 肝で、そこが崩れると「片方で開いた DB をもう片方が二重に migrate する」が起きる。
 *
 * `drizzle-orm/libsql/web` は HTTP 専用でローカル libSQL に向けられないため、
 * ここでは同型の node 版クライアントへ `migrateWebDb` を当てて検証する
 * （検証対象は migrator のロジックで、トランスポートではない）。
 */

/** ファイル DB を素で開く（migration は当てない） */
function openBare(): Db {
  const path = join(mkdtempSync(join(tmpdir(), "zakki-webmig-")), "db.sqlite");
  return drizzle(createClient({ url: `file:${path}` }), { schema });
}

let db: Db;

beforeEach(() => {
  db = openBare();
});

/** テーブル名の一覧（スキーマの一致を見るため） */
async function tableNames(target: Db): Promise<string[]> {
  const rows = await target.all<{ name: string }>(
    sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"),
  );
  return rows.map((r) => r.name);
}

/** `__drizzle_migrations` に記録された (hash, created_at) の一覧 */
async function applied(target: Db): Promise<{ hash: string; created_at: number }[]> {
  const rows = await target.all<{ hash: string; created_at: number }>(
    sql.raw("SELECT hash, created_at FROM `__drizzle_migrations` ORDER BY created_at"),
  );
  return rows.map((r) => ({ hash: r.hash, created_at: Number(r.created_at) }));
}

describe("migrateWebDb", () => {
  test("空の DB に全 migration を適用する", async () => {
    await migrateWebDb(db);

    const tables = await tableNames(db);
    expect(tables).toContain("chunks");
    expect(tables).toContain("repl_docs");
    expect(tables).toContain("key_envelopes");
    expect((await applied(db)).length).toBeGreaterThan(0);
  });

  test("2 回目は何もしない（冪等）", async () => {
    await migrateWebDb(db);
    const first = await applied(db);

    await migrateWebDb(db);

    expect(await applied(db)).toEqual(first);
  });

  test("node の migrator が作る状態と同じに収束する", async () => {
    // 同じスキーマ・同じ記録に落ちることが、両経路を混ぜても壊れない根拠
    const nodeDb = await createDb(":memory:");
    await migrateWebDb(db);

    expect(await tableNames(db)).toEqual(await tableNames(nodeDb));
    expect(await applied(db)).toEqual(await applied(nodeDb));
  });

  test("node の migrator が適用済みの DB では二重適用しない", async () => {
    const nodeDb = await createDb(":memory:");
    const before = await applied(nodeDb);

    await migrateWebDb(nodeDb);

    expect(await applied(nodeDb)).toEqual(before);
  });
});
