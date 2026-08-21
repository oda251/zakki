import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

/**
 * drizzle の migration を **バンドル可能な TS モジュール**へ書き出す（issue #134）。
 *   bun run gen-migrations
 *
 * 中継サーバ（apps/web）を Cloudflare Workers で動かすと、drizzle の migrator が
 * 使えない（`readMigrationFiles` が node:fs で SQL を読む）。一方ユーザごとの DB は
 * コントロールプレーンが実行時に作る空 DB なので、スキーマを入れる主体は中継サーバ
 * しか居ない（RESEARCH.md §7）。そこで SQL をソースに埋め込み、Workers 側は
 * `connect-web.ts` の migrator で適用する。
 *
 * 出力の形は drizzle の `MigrationMeta` と揃える（tag は生成物の可読性のため追加）:
 * - `sql`   … `--> statement-breakpoint` で分割した文の配列
 * - `hash`  … SQL ファイル全体の SHA-256（16 進）
 * - `folderMillis` … `meta/_journal.json` の `when`
 *
 * 揃えるのは、node 側（`drizzle-orm/libsql/migrator`）と Workers 側が **同じ
 * `__drizzle_migrations` テーブルを共有する**ため。片方が適用した DB をもう片方が
 * 開いても二重適用にならない（connect-web.test.ts がこれを縛る）。
 *
 * 生成物はコミットする。`just check` が再生成して差分が無いことを確かめる。
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DRIZZLE_DIR = join(HERE, "..", "drizzle");
const OUT = join(HERE, "..", "src", "db", "migrations.generated.ts");

/** drizzle の journal のうち、ここで使うフィールドだけ（外部ファイルなので検証して読む） */
const JournalSchema = v.object({
  entries: v.array(v.object({ tag: v.string(), when: v.number() })),
});

const journal = v.parse(
  JournalSchema,
  JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")),
);

const migrations = journal.entries.map((entry) => {
  const query = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
  return {
    tag: entry.tag,
    folderMillis: entry.when,
    hash: createHash("sha256").update(query).digest("hex"),
    // drizzle の readMigrationFiles と同じ分割。文の中身は加工しない
    sql: query.split("--> statement-breakpoint"),
  };
});

const body = `// このファイルは自動生成です。編集しないでください。
// 生成: bun run gen-migrations（packages/data/tools/gen-migrations.ts）
import type { EmbeddedMigration } from "@zakki/data/db/migration-types.ts";

/**
 * packages/data/drizzle を埋め込んだもの（issue #134）。Workers ランタイムは
 * node:fs で migration を読めないため、ソースに載せて配布する。
 */
export const EMBEDDED_MIGRATIONS: readonly EmbeddedMigration[] = ${JSON.stringify(migrations, null, 2)};
`;

writeFileSync(OUT, body);
console.error(`gen-migrations: ${migrations.length} 件を ${OUT} へ書き出しました`);
