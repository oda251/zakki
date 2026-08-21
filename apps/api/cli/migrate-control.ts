import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { parseMigrateEnv } from "./env.ts";

/**
 * コントロールプレーン DB へ migration を適用する（issue #131）。
 *   bun run migrate-control   … CONTROL_DB_URL / CONTROL_DB_TOKEN の DB へ apps/api/drizzle を適用
 *
 * Workers ランタイムでは実行できない（drizzle の migrator は node:fs で SQL ファイルを
 * 読む）ので、アプリ外のここが実行点になる。生成（`bun run --cwd apps/api generate`）は
 * drizzle-kit、適用はこの migrator——テスト（routes/me.test.ts 等）が実 libSQL に対して
 * 使っているのと同じ経路なので、本番へ当たるものとテストが検証したものが一致する。
 *
 * drizzle-kit migrate を使わないのは、既存の snapshot が `dialect: "sqlite"` で
 * 記録されており、Turso 接続のために `dialect: "turso"` へ替えると生成側と食い違うため。
 *
 * 冪等: 適用済みの migration は drizzle の管理テーブルで判定され、二度当たらない。
 */

// 合成点: 環境変数を起動時に一度だけ検証する（issue #48）
const config = parseMigrateEnv(process.env).match(
  (c) => c,
  (message): never => {
    console.error(`zakki migrate-control: ${message}`);
    process.exit(1);
  },
);

const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;
const client = createClient({ url: config.url, authToken: config.authToken });

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.error(`zakki migrate-control: 適用しました（${config.url}）`);
} catch (e) {
  console.error(`zakki migrate-control: 適用に失敗しました: ${String(e)}`);
  process.exit(1);
} finally {
  client.close();
}
