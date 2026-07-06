import type { Client } from "@libsql/client";
import type { Result } from "neverthrow";
import { ok } from "neverthrow";
import type { Identity } from "@zakki/core/identity/types.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { defaultDbPath, migrateDb, openClient } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";

/** アプリが使う DB ハンドル。クエリ用の Db と、ベストエフォートの同期口を持つ */
export interface DbHandle {
  readonly db: Db;
  /** リモートプライマリと push/pull する。ローカル専用なら no-op の Ok を返す */
  readonly sync: () => Promise<Result<void, DbError>>;
}

/**
 * Identity に応じて DB を開く（docs/RESEARCH.md §6 ローカルファースト）。
 * - turso の url と token が両方あれば embedded replica（ローカルファイル＋リモート同期先）。
 *   書き込みはローカルへ行われ、`sync()` で初めてリモートと往復する。
 * - いずれか欠ければローカル専用。`sync()` は no-op の Ok。
 *
 * 構築時にネットワーク I/O はしない（openClient は sync を呼ばない）ためオフラインでも開ける。
 */
export async function openDb(identity: Identity, path?: string): Promise<DbHandle> {
  const dbPath = path ?? defaultDbPath();
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
  // ローカル専用: 同期先が無いので no-op
  return { db, sync: () => Promise.resolve(ok(undefined)) };
}

/** embedded replica の同期。エラーは DbError に写す（呼び出し側がベストエフォート判断する） */
async function syncReplica(client: Client): Promise<Result<void, DbError>> {
  return await tryDbAsync(async () => {
    await client.sync();
  });
}
