import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Result } from "neverthrow";
import { ok } from "neverthrow";
import type { Identity } from "@zakki/core/identity/types.ts";
import type { Db, DbHandle, SyncOutcome } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { APP_DIR } from "@zakki/data/util/app-dir.ts";
import * as schema from "./schema.ts";

/**
 * DB アダプタ（connect 層, issue #29）。パス解決・PRAGMA・node:fs/os 依存は
 * すべてこのモジュールに封じ込める。リポジトリ・クエリ関数群と利用側は
 * ポート（client.ts の Db / DbHandle）だけを見る。
 */

/** embedded replica の同期設定（リモートプライマリ＋認証トークン） */
export interface SyncConfig {
  readonly syncUrl: string;
  readonly authToken: string;
}

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "..", "drizzle");

/** 既定の DB パス。dataHome は解決済みの XDG データディレクトリ（合成点が渡す） */
export function defaultDbPath(dataHome: string): string {
  return join(dataHome, APP_DIR, "zakki.sqlite");
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
export async function createDb(path: string): Promise<Db> {
  const { db } = await openClient(path);
  await migrateDb(db);
  return db;
}

/**
 * Identity に応じて DB を開く（docs/RESEARCH.md §6 ローカルファースト）。
 * - turso の url と token が両方あれば embedded replica（ローカルファイル＋リモート同期先）。
 *   書き込みはローカルへ行われ、`sync()` で初めてリモートと往復する。
 * - いずれか欠ければローカル専用。`sync()` は no-op の Ok。
 *
 * 構築時にネットワーク I/O はしない（openClient は sync を呼ばない）ためオフラインでも開ける。
 * path は合成点が `defaultDbPath(dataHome)` 等で解決して渡す。
 */
export async function openDb(identity: Identity, dbPath: string): Promise<DbHandle> {
  if (identity.tursoUrl !== undefined && identity.tursoToken !== undefined) {
    const { client, db } = await openClient(dbPath, {
      syncUrl: identity.tursoUrl,
      authToken: identity.tursoToken,
    });
    await migrateDb(db);
    return { db, sync: () => syncReplica(client) };
  }
  const { db } = await openClient(dbPath);
  await migrateDb(db);
  // ローカル専用: 同期先が無いので no-op（取り込みなし）
  return { db, sync: () => Promise.resolve(ok({ pulled: false })) };
}

/**
 * embedded replica の同期。エラーは DbError に写す（呼び出し側がベストエフォート判断する）。
 * pull 結果（Replicated.frames_synced）から「リモートのフレームを実際に適用したか」を
 * 返す（issue #55）。0 / undefined は no-op で、増分解析の基準は破れていない。
 */
async function syncReplica(client: Client): Promise<Result<SyncOutcome, DbError>> {
  return await tryDbAsync(async () => {
    const replicated = await client.sync();
    return { pulled: replicated !== undefined && replicated.frames_synced > 0 };
  });
}
