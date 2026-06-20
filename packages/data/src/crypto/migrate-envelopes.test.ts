import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { generateDek, wrapDek } from "@zakki/core/crypto/dek.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { unlockWithKeyfile } from "./envelopes.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
});

/** 0008 migration の crypto_meta → key_envelopes 移送 SQL（CREATE TABLE 部を除く）。 */
function migration0008CopyStatement(): string {
  const path = join(import.meta.dir, "..", "..", "drizzle", "0008_strange_hannibal_king.sql");
  const sqlText = readFileSync(path, "utf8");
  const stmts = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
  const copy = stmts.find((s) => s.startsWith("INSERT"));
  if (copy === undefined) {
    throw new Error("0008 の INSERT 移送 SQL が見つからない");
  }
  return copy;
}

describe("migration 0008: Phase 5 keyfile 互換", () => {
  test("crypto_meta の封筒を key_envelopes(keyfile) へ移送し、unlockWithKeyfile が通る", async () => {
    // Phase 5 DB を模す: crypto_meta に keyfile 封筒（kek_salt=null）を入れ、
    // key_envelopes は空にする（0008 適用前の状態を再現）。
    await db.run(sql`DELETE FROM key_envelopes`);

    const dek = generateDek();
    const kek = sodium.randombytes_buf(32);
    const envelope = wrapDek(dek, kek);
    await db.run(sql`
      INSERT INTO crypto_meta (id, version, wrapped_dek, kek_salt, created_at)
      VALUES (1, 1, ${Buffer.from(envelope)}, NULL, ${new Date().toISOString()})
    `);

    // 0008 の移送 SQL を適用
    await db.run(sql.raw(migration0008CopyStatement()));

    // keyfile 封筒が key_envelopes に存在する
    const rows = await db.all<{ kind: string }>(sql`SELECT kind FROM key_envelopes`);
    expect(rows.map((r) => r.kind)).toEqual(["keyfile"]);

    // 元の KEK で復元すると元の DEK に一致する
    const recovered = await unlockWithKeyfile(db, kek);
    expect(recovered.length).toBe(dek.length);
    expect(recovered.every((v, i) => v === dek[i])).toBe(true);
  });

  test("key_envelopes はフレッシュ DB（0008 適用済み）でも開ける空テーブルとして存在する", async () => {
    const rows = await db.all<{ kind: string }>(sql`SELECT kind FROM key_envelopes`);
    expect(rows).toEqual([]);
  });
});
