import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { err, ok, type Result } from "neverthrow";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountDatabases } from "@zakki/api/db/schema.ts";
import * as schema from "@zakki/api/db/schema.ts";
import type { PlatformFailure, TursoPlatform } from "@zakki/core/turso/platform.ts";
import { createTursoPlatform, TURSO_API_BASE_URL } from "@zakki/core/turso/platform.ts";
import { parseDbTokenEnv } from "./env.ts";
import { describeFailure } from "./provision.ts";

/**
 * TUI 用の長命 DB トークンを発行する（issue #135）。
 *   bun run db-token [accountId]   … そのアカウントの DB の URL とトークンを出力
 *
 * **なぜ要るか**: web / スマホをマルチユーザ構成にすると、ブラウザは `GET /me/db` が
 * 返す per-user DB へ同期する。TUI は単一ユーザ経路（`LocalIdentity`）で環境変数の
 * URL / トークンから DB を開くので、放っておくと**同じ日記が 2 つの DB に割れる**。
 * TUI を同じ DB へ向けるには接続情報が要る。
 *
 * **なぜ `/me/db` を使わないか**: あれはパスキー（WebAuthn）でログインしたセッションを
 * 前提としており、ブラウザ以外から通る経路が無い。返るトークンも TTL 60 分で
 * 常用には短すぎる（docs/RESEARCH.md §6, docs/MULTIUSER.md）。
 *
 * accountId は台帳（`account_databases`）を引く鍵。省略時、アカウントが 1 つだけなら
 * それを使う（自分ひとりの構成での手間を減らす）。複数あれば一覧を出して止まる。
 *
 * 出力したトークンは **その DB を開ける権限**であって復号鍵ではない。とはいえ
 * 日記そのものを読み書きできるので、置き場のファイル権限で守ること。
 */

/** 台帳から引いた DB の所在 */
export interface AccountDatabase {
  readonly accountId: string;
  readonly dbName: string;
  readonly dbHostname: string;
}

/** 台帳の引き当てに失敗した理由。どれも人が直せるものなので文言をそのまま出す */
export type LookupFailure =
  | { readonly kind: "empty" }
  | { readonly kind: "ambiguous"; readonly accountIds: readonly string[] }
  | { readonly kind: "not-found"; readonly accountId: string };

/**
 * accountId（省略可）から DB の所在を引く。
 *
 * 台帳に行があるのは `GET /me/db` を一度でも通ったアカウントだけ。まだなら
 * 「ブラウザで一度ログインしてください」と言えるよう `empty` / `not-found` を分ける。
 */
export async function lookupAccountDatabase(
  db: ControlDb,
  accountId: string | undefined,
): Promise<Result<AccountDatabase, LookupFailure>> {
  const rows = await db.select().from(accountDatabases);
  if (accountId === undefined) {
    if (rows.length === 0) return err({ kind: "empty" });
    const only = rows[0];
    if (rows.length > 1 || only === undefined) {
      return err({ kind: "ambiguous", accountIds: rows.map((r) => r.accountId) });
    }
    return ok(only);
  }
  const row = rows.find((r) => r.accountId === accountId);
  return row === undefined ? err({ kind: "not-found", accountId }) : ok(row);
}

/** 引き当てた DB に対して長命トークンを発行する */
export async function issueLongLivedToken(
  platform: TursoPlatform,
  dbName: string,
  expiration: string,
): Promise<Result<string, PlatformFailure>> {
  return platform.issueToken(dbName, { expiration, authorization: "full-access" });
}

function describeLookup(failure: LookupFailure): string {
  switch (failure.kind) {
    case "empty":
      return "台帳にアカウントがありません。先にブラウザでパスキー登録してログインしてください（そこで DB が作られます）";
    case "ambiguous":
      return `アカウントが複数あります。accountId を引数で指定してください: ${failure.accountIds.join(", ")}`;
    case "not-found":
      return `accountId ${failure.accountId} の DB が台帳にありません`;
    default:
      // switch-exhaustiveness-check が網羅を保証するので到達しない
      return "不明な失敗";
  }
}

if (import.meta.main) {
  // 合成点: 環境変数を起動時に一度だけ検証する（issue #48）
  const config = parseDbTokenEnv(process.env).match(
    (c) => c,
    (message): never => {
      console.error(`zakki db-token: ${message}`);
      process.exit(1);
    },
  );
  const accountId = process.argv[2];

  const client = createClient({ url: config.controlDbUrl, authToken: config.controlDbToken });
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え（apps/api のテストと同じ）
  const controlDb = drizzle(client, { schema }) as unknown as ControlDb;

  const found = await lookupAccountDatabase(controlDb, accountId);
  client.close();
  if (found.isErr()) {
    console.error(`zakki db-token: ${describeLookup(found.error)}`);
    process.exit(1);
  }

  const platform = createTursoPlatform({
    baseUrl: TURSO_API_BASE_URL,
    apiToken: config.apiToken,
    organization: config.organization,
    // トークン発行に group は要らない（DB は既にある）。設定の形を満たすための既定
    group: "zakki",
  });
  const token = await issueLongLivedToken(platform, found.value.dbName, config.expiration);
  if (token.isErr()) {
    console.error(`zakki db-token: ${describeFailure(token.error)}`);
    process.exit(1);
  }

  // 進捗は stderr。stdout は接続情報だけにして `just db-token > env` を成立させる
  console.error(
    `zakki db-token: accountId ${found.value.accountId} / ${found.value.dbName}（期限 ${config.expiration}）`,
  );
  console.log(`ZAKKI_TURSO_URL=libsql://${found.value.dbHostname}`);
  console.log(`ZAKKI_TURSO_TOKEN=${token.value}`);
}
