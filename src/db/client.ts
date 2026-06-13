import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { xdgDataHome } from "@/util/paths.ts";
import * as schema from "./schema.ts";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "..", "drizzle");

export function defaultDbPath(): string {
  return join(xdgDataHome(), "zakki", "zakki.sqlite");
}

/**
 * DB を開いてマイグレーションを適用する。起動時に 1 回呼ぶ。
 * 失敗は起動不能を意味するため throw する（以降のクエリ層は Result を返す）。
 */
export function createDb(path: string = defaultDbPath()): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}
