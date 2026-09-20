import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * コントロールプレーン DB スキーマ（issue #99, docs/RESEARCH.md §7）。
 *
 * ジャーナル DB（packages/data/src/db/schema.ts）とは完全に別の DB。
 * バックエンドは E2E 暗号を破れない立場を保つため、ここには本文・暗号鍵・
 * DEK（wrapped 含む）に関わる列を一切置かない。持つのはアカウント台帳・
 * 外部 ID プロバイダとの結び付け（OIDC）・ユーザごと Turso DB の所在だけ。
 */

/** アカウント。id はサーバ生成の不透明 ID（crypto.randomUUID 想定） */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  /**
   * セッションの世代（issue #117）。発行したセッショントークンにこの値を焼き込み、
   * 検証時に現在値と突き合わせる。ログアウトでこの値を +1 すれば、そのアカウントの
   * 発行済みトークンが一斉に「古い世代」になり無効化される。
   *
   * セッションテーブル（発行済みトークンの一覧）を持たないのは、コントロール
   * プレーンがリクエストごとに使い捨てられる実行環境で動くため——トークン 1 本ごとの
   * 行を書くと毎回のログインが書き込みになり、掃除も要る。世代番号ならアカウント
   * 1 行の整数で「全部無効」を表現でき、検証は既存のアカウント存在確認と同じ 1 クエリで済む。
   *
   * 既存行のために既定 0。認可の判定材料であって鍵材料ではない（E2E の境界は動かない）。
   */
  sessionEpoch: integer("session_epoch").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

/**
 * アカウントと外部 ID プロバイダ（OIDC）の結び付け（docs/MULTIUSER.md「ログイン（OIDC）」）。
 *
 * 同定は **`(provider, subject)`** で行う。メールは同定に使わない
 * （`subject` はプロバイダ内で不変な ID だが、メールは変わりうる上に
 * 複数プロバイダを跨いで同一人物と決め打つ根拠にもならない——別プロバイダの
 * `identity` が偶然同じメールを返しても自動で結び付けない）。
 * 主キーを `(provider, subject)` の複合にするのはこの同定ルールそのもので、
 * 一意制約を別立てにする必要が無い。
 */
export const accountIdentities = sqliteTable(
  "account_identities",
  {
    /** プロバイダの識別子。routes/auth.ts の `IdentityProvider.id`（例 "google"）と同じ */
    provider: text("provider").notNull(),
    /** プロバイダ内で不変の利用者 ID（OIDC の `sub`） */
    subject: text("subject").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** 連絡・表示用。プロバイダが返さなければ NULL（同定には使わない） */
    email: text("email"),
    /**
     * アカウント表示用の「主 identity」（issue #159）。アカウントごとに高々 1 つ
     * （部分一意インデックスで強制）。主が 0 件は DB では防げないので、表示時は
     * 最古の identity へフォールバックする（auth/identities.ts）。
     */
    isPrimary: integer("is_primary").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index("account_identities_account").on(t.accountId),
    uniqueIndex("account_identities_primary_unique")
      .on(t.accountId)
      .where(sql`"is_primary" = 1`),
  ],
);

/**
 * OIDC の state / PKCE verifier / nonce の短命ストア（docs/MULTIUSER.md「ログイン（OIDC）」）。
 *
 * Workers はリクエスト間で状態を持てない（isolate はいつでも捨てられる）ため、
 * `/auth/oidc/:provider/start` で発行した state・PKCE verifier・nonce を
 * メモリに置けない。state 自体を主キーにして「発行済みか」を DB で引き、
 * callback で必ず「消してから判定する」（単回使用）。
 * expiresAt を過ぎた行は無効扱いにし、発行のたびに掃除する
 * （旧 `auth_challenges` と同じ運用。auth/oidc-states.ts）。
 *
 * provider を持つのは、ある provider 用に発行した state を別 provider の
 * callback へ流し込めないようにするため（取り違え防止。旧 `authChallenges.kind` と同じ理由）。
 */
export const oidcStates = sqliteTable(
  "oidc_states",
  {
    /** 認可 URL・callback に載る state そのもの。単回使用なので主キーで足りる */
    state: text("state").primaryKey(),
    provider: text("provider").notNull(),
    /** PKCE の code_verifier。token エンドポイントへ渡すまで DB にしか無い */
    codeVerifier: text("code_verifier").notNull(),
    /** id_token の nonce 検証に使う */
    nonce: text("nonce").notNull(),
    /** 失効時刻（epoch ミリ秒）。過ぎた行は無効・掃除対象 */
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("oidc_states_expires").on(t.expiresAt)],
);

/**
 * ログイン handoff の使い捨てコード（docs/MULTIUSER.md「ログイン（OIDC）」）。
 *
 * OIDC の callback はブラウザへの 302 リダイレクトで終わるため、この時点で
 * セッション JWT をそのまま URL に載せると履歴・Referer・アクセスログに残る
 * （fragment はサーバへ送られないが履歴には残る）。そこで一度きりの短命コードだけを
 * fragment に載せ、SPA が `POST /auth/login/exchange` で本物のセッションに換える。
 */
export const loginHandoffs = sqliteTable("login_handoffs", {
  /** ランダムな使い捨てコードそのもの。単回使用なので主キーで足りる */
  code: text("code").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  /** 失効時刻（epoch ミリ秒）。短い TTL（auth/handoffs.ts）で掃除する */
  expiresAt: integer("expires_at").notNull(),
});

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
