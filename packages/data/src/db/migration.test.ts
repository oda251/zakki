import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { createDb } from "./connect.ts";

/**
 * 0010_chunk_tree マイグレーションの検証。
 * 旧スキーマ（0000..0009 適用済み）の DB を実データ入りで組み立て、createDb
 * （migrate 0010 適用）で開いて、chunk 自己参照ツリーへの再構築を確認する。
 */

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");
/** 0009_sessions の journal `when`。これを記録しておくと migrate は 0010 だけを適用する */
const WHEN_0009 = 1783182391764;

async function buildLegacyDb(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "zakki-mig-")), "db.sqlite");
  const client = createClient({ url: `file:${path}` });
  const files = [
    "0000_init.sql",
    "0001_corrections.sql",
    "0002_tags-links.sql",
    "0003_embeddings.sql",
    "0004_conversion_cache.sql",
    "0005_chunk_polarity.sql",
    "0006_drop_chunk_title.sql",
    "0007_cynical_power_man.sql",
    "0008_strange_hannibal_king.sql",
    "0009_sessions.sql",
  ];
  for (const file of files) {
    const raw = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const stmt of raw.split("--> statement-breakpoint")) {
      if (stmt.trim() !== "") await client.execute(stmt);
    }
  }
  // drizzle の適用記録（最後の 1 行だけ見るため 0009 の when を入れる）
  await client.execute(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
  );
  await client.execute({
    sql: "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    args: ["legacy-seed", WHEN_0009],
  });

  const now = "2026-07-01T00:00:00.000Z";
  // sessions: 07-01 デフォルト + 名前付き「調査」、07-03 デフォルト
  await client.execute({
    sql: "INSERT INTO sessions (id, name, date, created_at, updated_at) VALUES (1, NULL, '2026-07-01', ?, ?), (2, '調査', '2026-07-01', ?, ?), (3, NULL, '2026-07-03', ?, ?)",
    args: [now, now, now, now, now, now],
  });
  await client.execute({
    sql: "INSERT INTO entries (id, session_id, date, raw, converted, created_at, updated_at) VALUES (1, 1, '2026-07-01', 'r1', 'c1', ?, ?), (2, 2, '2026-07-01', 'r2', 'c2', ?, ?), (3, 3, '2026-07-03', 'r3', 'c3', ?, ?)",
    args: [now, now, now, now, now, now],
  });
  await client.execute({
    sql: "INSERT INTO chunks (id, entry_id, position, content, polarity, created_at, updated_at) VALUES (1, 1, 0, '一。', 0.5, ?, ?), (2, 1, 1, '二。', NULL, ?, ?), (3, 2, 0, '三。', NULL, ?, ?), (4, 3, 0, '四。', NULL, ?, ?)",
    args: [now, now, now, now, now, now, now, now],
  });
  await client.execute({
    sql: "INSERT INTO session_tags (session_id, name, name_fingerprint, created_at) VALUES (2, 'web', 'web', ?), (1, 'daily', 'daily', ?)",
    args: [now, now],
  });
  await client.execute(
    "INSERT INTO links (from_chunk_id, to_chunk_id, score, origin) VALUES (1, 3, 0.9, 'auto')",
  );
  client.close();
  return path;
}

describe("0010_chunk_tree", () => {
  test("旧 sessions/entries/chunks を自己参照ツリーへ再構築する", async () => {
    const path = await buildLegacyDb();
    const db = await createDb(path);

    const rows = (
      await db.run(
        sql`SELECT id, parent_id AS parentId, position, content, date FROM chunks ORDER BY id`,
      )
    ).rows as unknown as {
      id: number;
      parentId: number | null;
      position: number;
      content: string;
      date: string | null;
    }[];

    // 日付チャンク: 2 件（1 日 1 件）、トップレベル、content = date
    const dateChunks = rows.filter((r) => r.date !== null);
    expect(dateChunks.map((r) => [r.date, r.parentId, r.content])).toEqual([
      ["2026-07-01", null, "2026-07-01"],
      ["2026-07-03", null, "2026-07-03"],
    ]);
    const dc0701 = dateChunks[0];
    const dc0703 = dateChunks[1];
    if (dc0701 === undefined || dc0703 === undefined) throw new Error("日付チャンク不足");

    // コンテナ（旧・名前付きセッション）: 日付チャンクの子、position はデフォルト本文の直後
    const container = rows.find((r) => r.content === "調査");
    expect(container).toMatchObject({ parentId: dc0701.id, position: 2, date: null });
    if (container === undefined) throw new Error("コンテナ不足");

    // 本文チャンク: id 保存・親配線
    expect(rows.find((r) => r.id === 1)).toMatchObject({
      parentId: dc0701.id,
      position: 0,
      content: "一。",
    });
    expect(rows.find((r) => r.id === 2)).toMatchObject({ parentId: dc0701.id, position: 1 });
    expect(rows.find((r) => r.id === 3)).toMatchObject({ parentId: container.id, position: 0 });
    expect(rows.find((r) => r.id === 4)).toMatchObject({ parentId: dc0703.id, position: 0 });

    // links は chunk id 不変で無傷
    const linkRows = (await db.run(sql`SELECT from_chunk_id AS f, to_chunk_id AS t FROM links`))
      .rows as unknown as { f: number; t: number }[];
    expect(linkRows).toEqual([{ f: 1, t: 3 }]);

    // セッションタグ → chunk_user_tags（名前付き = コンテナ / デフォルト = 日付チャンク）
    const tagRows = (
      await db.run(sql`SELECT chunk_id AS chunkId, name FROM chunk_user_tags ORDER BY id`)
    ).rows as unknown as { chunkId: number; name: string }[];
    expect(tagRows).toEqual([
      { chunkId: container.id, name: "web" },
      { chunkId: dc0701.id, name: "daily" },
    ]);

    // AAD 付替え予約: コンテナ content とユーザタグ全行
    const fixups = (await db.run(sql`SELECT kind, row_id AS rowId FROM aad_fixups ORDER BY id`))
      .rows as unknown as { kind: string; rowId: number }[];
    expect(fixups.filter((f) => f.kind === "chunk.content").map((f) => f.rowId)).toEqual([
      container.id,
    ]);
    expect(fixups.filter((f) => f.kind === "chunkUserTag.name")).toHaveLength(2);

    // 旧テーブルは消えている
    const tables = (
      await db.run(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'session_tags', 'entries', 'chunks_new')`,
      )
    ).rows;
    expect(tables).toHaveLength(0);

    // 新規 id は既存 id と衝突しない（AUTOINCREMENT 続き）
    expect(Math.min(dc0701.id, dc0703.id, container.id)).toBeGreaterThan(4);
  });

  test("空 DB（新規）にも適用できる", async () => {
    const db = await createDb(":memory:");
    const rows = (await db.run(sql`SELECT count(*) AS n FROM chunks`)).rows as unknown as {
      n: number;
    }[];
    expect(rows[0]?.n).toBe(0);
  });
});
