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

/**
 * sync 1 回分の結果（issue #55）。pulled=true はリモートのフレームを適用し、
 * ローカル DB が「本プロセスの書き込み以外」で変化したことを示す。呼び出し側は
 * これを見て増分解析のスナップショットを破棄する（単一ライタ前提の回復）。
 */
export interface SyncOutcome {
  readonly pulled: boolean;
}

/** アプリが使う DB ハンドル。クエリ用の Db と、ベストエフォートの同期口を持つ */
export interface DbHandle {
  readonly db: Db;
  /** リモートプライマリと push/pull する。ローカル専用なら no-op の Ok（pulled=false）を返す */
  readonly sync: () => Promise<Result<SyncOutcome, DbError>>;
}
