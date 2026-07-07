/**
 * RxDB テスト用フィクスチャ（server/replication/test-fixtures.ts と同じ流儀）。
 *
 * dev-mode + ajv + memory storage の組（IndexedDB 不要 = opentui のグローバル
 * 汚染を受けない）をテスト間で共有する。本番コードはこれらのプラグインを
 * import しない（database.ts の方針）ため、このファイルはテスト専用。
 */
import { addRxPlugin } from "rxdb";
import type { RxStorage } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { createZakkiDb } from "@zakki/web/client/db/database.ts";

addRxPlugin(RxDBDevModePlugin);

export function testStorage(): RxStorage<unknown, unknown> {
  return wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
}

export async function openTestDb(name?: string): Promise<ZakkiDatabase> {
  return createZakkiDb(testStorage(), name);
}
