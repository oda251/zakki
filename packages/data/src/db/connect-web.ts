import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql/web";
import type { Identity } from "@zakki/core/identity/types.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { EmbeddedMigration } from "@zakki/data/db/migration-types.ts";
import { EMBEDDED_MIGRATIONS } from "@zakki/data/db/migrations.generated.ts";
import * as schema from "./schema.ts";

/**
 * Workers 向けの DB アダプタ（issue #134）。
 *
 * `connect.ts` は node:fs / node:os に依存する（ローカルファイル・埋め込みレプリカ・
 * migration の読み出し）ため Workers では読み込めない。中継サーバを Workers で動かす
 * 構成では **ローカルコピーを持たない** ので、必要なのは
 * 「リモート DB を HTTP で開く」ことだけになる。ここはその 1 経路に絞る。
 *
 * - クライアントは `drizzle-orm/libsql/web`（内部で `@libsql/client/web` = HTTP のみ）。
 *   素の `drizzle-orm/libsql` は node 版クライアントを静的 import する
 * - PRAGMA は張らない（リクエストごとにステートレスな HTTP では接続単位の設定が効かない）
 * - migration はソースに埋め込んだ SQL（migrations.generated.ts）を適用する
 */

/** drizzle の migration 記録テーブル。node 側の migrator と同じ名前・同じ形を使う */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * リモート DB を HTTP で開く（Workers 可）。ネットワーク I/O は最初のクエリまで発生しない。
 *
 * 戻り値の型は node 版 {@link Db} と同じ扱いにする。両者はクエリ面が同型で、
 * data 層の関数はどちらでも動く（apps/api が node 版 → web 版を読み替えているのと同じ整理）。
 */
export function openWebDb(url: string, authToken: string): Db {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- web 版 → node 版の型の読み替え（クエリ面は同型）
  return drizzle({ connection: { url, authToken }, schema }) as unknown as Db;
}

/**
 * 埋め込み migration を適用する（冪等）。
 *
 * 判定基準は drizzle の migrator と同じ「記録済みの最後の `created_at` より新しい
 * `folderMillis` のものを流す」。テーブル定義・記録する値も揃えてあるので、
 * node 側（`drizzle-orm/libsql/migrator`）が適用した DB をここで開いても二重適用に
 * ならないし、その逆も成り立つ（connect-web.test.ts が縛る）。
 *
 * 1 つの batch にまとめるのは drizzle と同じ（途中まで適用された状態を作らない）。
 */
export async function migrateWebDb(
  db: Db,
  migrations: readonly EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
): Promise<void> {
  await db.run(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )`,
    ),
  );
  const rows = await db.all<{ created_at: number | string | null }>(
    sql.raw(
      `SELECT id, hash, created_at FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at DESC LIMIT 1`,
    ),
  );
  const lastMillis = rows[0] === undefined ? null : Number(rows[0].created_at);

  const pending = migrations.filter(
    (m) => lastMillis === null || Number.isNaN(lastMillis) || lastMillis < m.folderMillis,
  );
  if (pending.length === 0) return;

  const statements = pending.flatMap((migration) => [
    ...migration.sql.map((statement) => db.run(sql.raw(statement))),
    db.run(
      sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`,
    ),
  ]);
  // batch は 1 要素以上が前提。pending が空でないので必ず満たす
  // oxlint-disable-next-line typescript/consistent-type-assertions -- drizzle の batch が要求する「1 要素以上」の形へ
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
}

/**
 * Identity からリモート DB を開いて migration を適用する（Workers 版の `openRemoteDb`）。
 *
 * ユーザごとの DB はコントロールプレーンが実行時に作る空 DB で、スキーマを入れる
 * 主体が他に居ないため、ここで適用する（node 版 `openRemoteDb` と同じ責務）。
 */
export async function openRemoteWebDb(identity: Identity): Promise<Db> {
  if (identity.tursoUrl === undefined || identity.tursoToken === undefined) {
    throw new Error("リモート DB の接続情報（url / token）がありません");
  }
  const db = openWebDb(identity.tursoUrl, identity.tursoToken);
  await migrateWebDb(db);
  return db;
}
