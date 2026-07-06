import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { xdgDataHome } from "@zakki/data/util/paths.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** embedded replica の同期設定（リモートプライマリ＋認証トークン） */
export interface SyncConfig {
  readonly syncUrl: string;
  readonly authToken: string;
}

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "..", "drizzle");

export function defaultDbPath(): string {
  return join(xdgDataHome(), "zakki", "zakki.sqlite");
}

/**
 * ファイルパスを libSQL の URL へ写す。
 * libSQL の `:memory:` はコネクション単位で独立し、トランザクションが別コネクションで
 * 走るとテーブルが見えない。テスト用の使い捨て・独立 DB を保つため、`:memory:` は
 * プロセスごとにユニークな一時ファイルへ写す（共有キャッシュは全 DB が 1 つになり隔離を壊す）。
 */
function toLibsqlUrl(path: string): string {
  if (path === ":memory:") {
    return `file:${join(mkdtempSync(join(tmpdir(), "zakki-mem-")), "db.sqlite")}`;
  }
  mkdirSync(dirname(path), { recursive: true });
  return `file:${path}`;
}

/**
 * libSQL クライアントを開く共通処理（マイグレーションは行わない）。
 * `sync` を渡すと embedded replica（ローカルファイル＋リモート同期先）として開く。
 * 同期そのものもここでは行わない（構築はオフラインでも成功する）。
 */
export async function openClient(
  path: string,
  sync?: SyncConfig,
): Promise<{ client: Client; db: Db }> {
  const url = toLibsqlUrl(path);
  const client =
    sync === undefined
      ? createClient({ url })
      : createClient({ url, syncUrl: sync.syncUrl, authToken: sync.authToken });
  // FK cascade に依存する（store.ts はチャンク削除で embeddings を連鎖削除する）
  await client.execute("PRAGMA foreign_keys = ON");
  if (sync === undefined) {
    // 書き込み（保存・解析パス）中も読み（graph/related）をブロックしないよう WAL にする。
    // embedded replica は libsql 側が WAL 前提で管理するため触らない。
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
  }
  const db = drizzle(client, { schema });
  return { client, db };
}

/**
 * マイグレーションを適用する。合成点（createDb / openDb）が接続直後に明示的に呼ぶ。
 *
 * 接続（openClient）から分離しているのは CF Workers 適合のため: drizzle migrator は
 * 実行時に migrations フォルダを node:fs で読むため Workers では実行できない。
 * Workers ターゲットは「migrate を呼ばない合成」（デプロイ時に primary へ適用済み）を
 * 取る（docs/RESEARCH.md §6 の暗号文ストア方針）。
 */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * DB を開いてマイグレーションを適用する。起動時に 1 回呼ぶ。
 * 失敗は起動不能を意味するため throw する（以降のクエリ層は Result を返す）。
 */
export async function createDb(path: string = defaultDbPath()): Promise<Db> {
  const { db } = await openClient(path);
  await migrateDb(db);
  return db;
}
