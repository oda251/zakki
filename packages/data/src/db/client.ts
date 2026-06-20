import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { xdgDataHome } from "@zakki/data/util/paths.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

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
 * DB を開いてマイグレーションを適用する。起動時に 1 回呼ぶ。
 * 失敗は起動不能を意味するため throw する（以降のクエリ層は Result を返す）。
 */
export async function createDb(path: string = defaultDbPath()): Promise<Db> {
  const client = createClient({ url: toLibsqlUrl(path) });
  // FK cascade に依存する（store.ts はチャンク削除で embeddings を連鎖削除する）
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}
