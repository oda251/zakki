import type { drizzle } from "drizzle-orm/libsql";
import type { Result } from "neverthrow";
import type { DbError } from "@zakki/data/db/error.ts";
import type * as schema from "./schema.ts";

/**
 * データ層のポート（issue #29）。リポジトリ・クエリ関数群とその利用側
 * （web routes / TUI）は、このモジュールの型だけに依存する。
 *
 * 接続の実体（libSQL クライアント生成・パス解決・PRAGMA・node:fs/os）は
 * DB アダプタ（connect.ts）に封じ込めてあり、ここからは到達しない。
 * クラウド/wasm ターゲットへの差し替えは connect 層の置き換えで行う。
 */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** アプリが使う DB ハンドル。クエリ用の Db と、ベストエフォートの同期口を持つ */
export interface DbHandle {
  readonly db: Db;
  /** リモートプライマリと push/pull する。ローカル専用なら no-op の Ok を返す */
  readonly sync: () => Promise<Result<void, DbError>>;
}
