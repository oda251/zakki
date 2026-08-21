import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";
import { TURSO_DEFAULT_LOCATION } from "@zakki/core/turso/platform.ts";

/**
 * ブートストラップ CLI の環境変数スキーマ（issue #131）。
 *
 * apps/api/src/env.ts（Worker の実行時設定）とは**別物**で、意図的に分けてある:
 * こちらは組織スコープの `TURSO_API_TOKEN`——組織のあらゆる DB を作成・**削除**できる
 * 権限——を受け取る。アプリが常時保持するには強すぎるため、`just provision` の実行時
 * だけ環境から読み、どこにも保存しない。アプリが持つのは DB スコープのトークンのみ。
 *
 * CLI は Workers ではなく bun で動くので、ここは `process.env` を読んでよい合成点
 * （scripts/check-arch-guards.sh Guard 1 の許可リストに登録済み）。
 */

/** 必須の環境変数: 非空文字列のみ受け付ける */
const required = v.pipe(v.string("設定されていません"), v.minLength(1, "空にできません"));

/** 省略可の環境変数。既定値へ畳むのは transform 側（`optional` 単体では未設定時に評価されない） */
const optional = v.optional(v.string());

/** 未設定・空文字列（`export FOO=` の取りこぼし）を既定値に畳む */
function orDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

/** group 名の既定。Pulumi 時代の `groupName` 既定と同じ値にしてある */
const DEFAULT_GROUP = "zakki";

/** コントロールプレーン DB 名の既定。stack ごとに分けたいときだけ上書きする */
const DEFAULT_CONTROL_DB_NAME = "zakki-control-prod";

const ProvisionEnvSchema = v.pipe(
  v.object({
    TURSO_API_TOKEN: required,
    TURSO_ORG: required,
    TURSO_GROUP: optional,
    TURSO_GROUP_LOCATION: optional,
    CONTROL_DB_NAME: optional,
  }),
  v.transform((env) => ({
    /** 組織スコープの Platform API トークン。この実行の間だけ持つ */
    apiToken: env.TURSO_API_TOKEN,
    /** organization slug */
    organization: env.TURSO_ORG,
    /** DB を束ねる group。無ければ作る */
    group: orDefault(env.TURSO_GROUP, DEFAULT_GROUP),
    /** group を新規作成するときの primary ロケーション（AWS リージョン形式） */
    groupLocation: orDefault(env.TURSO_GROUP_LOCATION, TURSO_DEFAULT_LOCATION),
    /** コントロールプレーン DB の名前 */
    controlDbName: orDefault(env.CONTROL_DB_NAME, DEFAULT_CONTROL_DB_NAME),
  })),
);

const MigrateEnvSchema = v.pipe(
  v.object({
    CONTROL_DB_URL: required,
    CONTROL_DB_TOKEN: required,
  }),
  v.transform((env) => ({
    /** `just provision` が出力した libsql URL */
    url: env.CONTROL_DB_URL,
    /** 同じく DB スコープのトークン */
    authToken: env.CONTROL_DB_TOKEN,
  })),
);

export type ProvisionConfig = v.InferOutput<typeof ProvisionEnvSchema>;
export type MigrateConfig = v.InferOutput<typeof MigrateEnvSchema>;

/** 検証エラーをどの変数が不正か分かる 1 行にまとめる */
function describe(issues: readonly v.BaseIssue<unknown>[]): string {
  const details = issues
    .map((issue) => `${v.getDotPath(issue) ?? "(不明)"}: ${issue.message}`)
    .join("、");
  return `環境変数が不正です — ${details}`;
}

export function parseProvisionEnv(env: Record<string, unknown>): Result<ProvisionConfig, string> {
  const result = v.safeParse(ProvisionEnvSchema, env);
  return result.success ? ok(result.output) : err(describe(result.issues));
}

export function parseMigrateEnv(env: Record<string, unknown>): Result<MigrateConfig, string> {
  const result = v.safeParse(MigrateEnvSchema, env);
  return result.success ? ok(result.output) : err(describe(result.issues));
}
