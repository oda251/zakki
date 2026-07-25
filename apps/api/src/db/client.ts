import { drizzle } from "drizzle-orm/libsql/web";
import * as schema from "./schema.ts";

/**
 * コントロールプレーン DB クライアント（issue #99）。
 *
 * 本番は `drizzle-orm/libsql/web`（内部で `@libsql/client/web` = HTTP のみ）を
 * 使う。素の `drizzle-orm/libsql` は node 版 `@libsql/client` を静的 import する
 * ため Workers では動かない。テストは node 版クライアント + 同じ schema で
 * 同型の ControlDb を組み立てて注入する（プロトコル互換なので mock 不要）。
 *
 * migration はここでは適用しない: drizzle migrator はファイルシステム依存で
 * Workers では実行できないため、デプロイ時に primary へ適用しておく
 * （packages/data/src/db/connect.ts の migrateDb と同じ整理）。
 */
export type ControlDb = ReturnType<typeof drizzle<typeof schema>>;

/** 接続情報。合成点（index.ts）が検証済み env から渡す */
export interface ControlDbConfig {
  readonly url: string;
  readonly authToken: string;
}

/** コントロールプレーン DB を開く（ネットワーク I/O は最初のクエリまで発生しない） */
export function createControlDb(config: ControlDbConfig): ControlDb {
  return drizzle({
    connection: { url: config.url, authToken: config.authToken },
    schema,
  });
}
