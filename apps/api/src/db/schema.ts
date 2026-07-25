import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * コントロールプレーン DB スキーマ（issue #99, docs/RESEARCH.md §7）。
 *
 * ジャーナル DB（packages/data/src/db/schema.ts）とは完全に別の DB。
 * バックエンドは E2E 暗号を破れない立場を保つため、ここには本文・暗号鍵・
 * DEK（wrapped 含む）に関わる列を一切置かない。持つのはアカウント台帳・
 * WebAuthn クレデンシャル・ユーザごと Turso DB の所在だけ。
 */

/** アカウント。id はサーバ生成の不透明 ID（crypto.randomUUID 想定） */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
});

/**
 * WebAuthn クレデンシャル（api-2 のパスキー認証が使う）。
 * publicKey は COSE 公開鍵の base64url（Workers に Node Buffer が無いため
 * blob ではなく文字列で持つ）。transports は JSON 配列文字列（未取得は NULL）。
 */
export const credentials = sqliteTable(
  "credentials",
  {
    credentialId: text("credential_id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    /** WebAuthn signature counter（クローン検知）。認証成功ごとに更新する */
    counter: integer("counter").notNull(),
    transports: text("transports"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("credentials_account").on(t.accountId)],
);

/**
 * WebAuthn challenge の短命ストア（api-2, issue #100）。
 *
 * Workers はリクエスト間で状態を持てない（isolate はいつでも捨てられる）ため、
 * options 発行 → verify の間の challenge をメモリに置けない。challenge 自体を
 * 主キーにして「発行済みか」を DB で引き、verify 時に必ず消す（単回使用）。
 * expiresAt を過ぎた行は無効扱いにし、発行のたびに掃除する。
 *
 * accountId は registration のときだけ入る（options 時点で採番した account の
 * 予約。verify が通って初めて accounts へ INSERT するので FK は張れない）。
 * authentication では NULL で、アカウントは提示されたクレデンシャルから引く。
 */
export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    /** base64url の challenge そのもの。単回使用なので主キーで足りる */
    challenge: text("challenge").primaryKey(),
    /** "registration" | "authentication"。取り違え（登録用を認証に流用）を防ぐ */
    kind: text("kind").notNull(),
    /** registration で予約した account id。authentication では NULL */
    accountId: text("account_id"),
    /** 失効時刻（epoch ミリ秒）。過ぎた行は無効・掃除対象 */
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("auth_challenges_expires").on(t.expiresAt)],
);

/**
 * アカウント → ユーザごと Turso DB の台帳（api-3 のプロビジョニングが書く）。
 * DB の所在（名前・ホスト名）のみ。アクセストークンは都度 scoped 発行するため
 * 保存しない。E2E のため本文・鍵・DEK に関わる列は将来も追加しない。
 */
export const accountDatabases = sqliteTable("account_databases", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  dbName: text("db_name").notNull(),
  dbHostname: text("db_hostname").notNull(),
  createdAt: text("created_at").notNull(),
});
