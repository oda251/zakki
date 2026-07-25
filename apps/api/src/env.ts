import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

/**
 * コントロールプレーンの環境変数スキーマ検証（issue #99）。
 *
 * Workers に Node 的なプロセス環境変数は無く、env は fetch ハンドラの第2引数で渡る。
 * 合成点（index.ts）が最初のリクエストで一度だけ `parseApiEnv` で検証し、
 * 以降は型付きの `ApiConfig` を注入する（issue #48 の合成点パターン）。
 * 全変数が必須: 欠落・空文字列は変数名を示して起動失敗にする。
 */

/** 必須の環境変数: 非空文字列のみ受け付ける */
const required = v.pipe(v.string("設定されていません"), v.minLength(1, "空にできません"));

/**
 * 環境変数スキーマ。キーは環境変数名そのもの（検証エラーで変数名を示すため）で、
 * 出力は camelCase の設定オブジェクトへ写す。未知のキー（Workers の
 * バインディング等）は無視する。
 */
const EnvSchema = v.pipe(
  v.object({
    CONTROL_DB_URL: required,
    CONTROL_DB_TOKEN: required,
    SESSION_SECRET: required,
    TURSO_API_TOKEN: required,
    TURSO_ORG: required,
    TURSO_GROUP: required,
    RP_ID: required,
    RP_ORIGIN: required,
  }),
  v.transform((env) => ({
    /** コントロールプレーン DB（Turso）の URL */
    controlDbUrl: env.CONTROL_DB_URL,
    /** コントロールプレーン DB の認証トークン */
    controlDbToken: env.CONTROL_DB_TOKEN,
    /** セッション署名鍵（api-2 のセッション管理が使う） */
    sessionSecret: env.SESSION_SECRET,
    /** Turso Platform API トークン（api-3 のプロビジョニングが使う） */
    tursoApiToken: env.TURSO_API_TOKEN,
    /** Turso organization slug */
    tursoOrg: env.TURSO_ORG,
    /** ユーザ DB を作る Turso group */
    tursoGroup: env.TURSO_GROUP,
    /** WebAuthn Relying Party ID（api-2） */
    rpId: env.RP_ID,
    /** WebAuthn Relying Party origin（api-2） */
    rpOrigin: env.RP_ORIGIN,
  })),
);

/** 起動時に検証済みの型付き設定。合成点から各層へ必要なフィールドだけ渡す */
export type ApiConfig = v.InferOutput<typeof EnvSchema>;

/**
 * Workers の env を検証して ApiConfig へ写す。失敗時はどの変数が不正かを含む
 * メッセージを返す（合成点はこれを明示エラーとして throw する）。
 */
export function parseApiEnv(env: Record<string, unknown>): Result<ApiConfig, string> {
  const result = v.safeParse(EnvSchema, env);
  if (result.success) {
    return ok(result.output);
  }
  const details = result.issues
    .map((issue) => `${v.getDotPath(issue) ?? "(不明)"}: ${issue.message}`)
    .join("、");
  return err(`環境変数が不正です — ${details}`);
}
