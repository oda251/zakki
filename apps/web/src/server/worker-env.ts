import { err, ok, type Result } from "neverthrow";
import type { FileRetention } from "@zakki/core/file/upload.ts";
import * as v from "valibot";
import type { R2BucketLike } from "./files/store.ts";

/**
 * Workers 配備の中継サーバが要る設定（issue #134）。
 *
 * bun 版（`packages/core/src/config/env.ts` の `ZakkiConfig`）とは別スキーマにする。
 * あちらは TUI とサーバで共有する大きな設定（XDG パス・ポート・埋め込みレプリカの
 * 接続情報・暗号フラグ）で、その大半は Workers に**存在しない前提**のものだから。
 * ここで要るのは中継先を決めるための 1 つだけ。
 *
 * Workers に process 環境は無く、env は fetch の第 2 引数で渡る。合成点（worker.ts）が
 * 最初のリクエストで一度だけ検証する（issue #48 の合成点パターン）。
 */
const EnvSchema = v.pipe(
  v.object({
    ZAKKI_CONTROL_PLANE_URL: v.pipe(
      v.string("設定されていません"),
      v.minLength(1, "空にできません"),
    ),
  }),
  v.transform((env) => ({
    /**
     * コントロールプレーン（apps/api）の base URL。
     *
     * Workers 版は**マルチユーザ専用**なので必須にする（bun 版では未設定 = 単一ユーザ
     * self-host という意味を持つが、こちらはローカル DB を開かないので単一ユーザ構成が
     * そもそも成立しない）。未設定のまま配備したら黙って壊れるより起動失敗の方がよい。
     */
    controlPlaneUrl: env.ZAKKI_CONTROL_PLANE_URL,
  })),
);

export type RelayConfig = v.InferOutput<typeof EnvSchema>;

/** Service Binding の最小面（Worker → Worker 直結の `fetch`） */
export interface ServiceBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

const R2_BINDING_NAMES = {
  permanent: "FILES_PERMANENT",
  "1d": "FILES_1D",
  "7d": "FILES_7D",
  "30d": "FILES_30D",
} as const satisfies Record<FileRetention, string>;

function isR2BucketLike(value: unknown): value is R2BucketLike {
  if (typeof value !== "object" || value === null) return false;
  return (
    "createMultipartUpload" in value &&
    typeof value.createMultipartUpload === "function" &&
    "resumeMultipartUpload" in value &&
    typeof value.resumeMultipartUpload === "function" &&
    "get" in value &&
    typeof value.get === "function" &&
    "delete" in value &&
    typeof value.delete === "function"
  );
}

export function r2BucketBindings(
  env: Record<string, unknown>,
): Record<FileRetention, R2BucketLike> | null {
  const permanent = r2Bucket(env, R2_BINDING_NAMES.permanent);
  const oneDay = r2Bucket(env, R2_BINDING_NAMES["1d"]);
  const sevenDays = r2Bucket(env, R2_BINDING_NAMES["7d"]);
  const thirtyDays = r2Bucket(env, R2_BINDING_NAMES["30d"]);
  if (permanent === null || oneDay === null || sevenDays === null || thirtyDays === null) {
    return null;
  }
  return { permanent, "1d": oneDay, "7d": sevenDays, "30d": thirtyDays };
}

function r2Bucket(env: Record<string, unknown>, name: string): R2BucketLike | null {
  const binding = env[name];
  return isR2BucketLike(binding) ? binding : null;
}

/**
 * 名前つき Service Binding を取り出す（`CONTROL_PLANE`, issue #134）。
 *
 * **公開 URL では Worker → Worker が通らない。** 同じアカウントの workers.dev を
 * Worker から fetch すると自分自身へループバックし、`/auth/me` が中継サーバの
 * SPA フォールバック（200 HTML）を返す。JSON パースに失敗して「セッション解決不能」
 * に化けるだけで例外は出ないので、**症状は静かな 401** になる（実配備で判明）。
 *
 * Service Binding なら公衆網へ出ずに直接もう一方の Worker を呼べる。
 *
 * ブラウザ → コントロールプレーンは従来どおり公開 URL 直叩き（`GET /api/config` が
 * 返す `controlPlaneUrl`）で、そちらは CORS が要る。**サーバ側の呼び出しだけ**が
 * この binding を通る。
 */
export function serviceBinding(env: Record<string, unknown>, name: string): ServiceBinding | null {
  const binding = env[name];
  if (typeof binding !== "object" || binding === null || !("fetch" in binding)) return null;
  if (typeof binding.fetch !== "function") return null;
  // oxlint-disable-next-line typescript/consistent-type-assertions -- binding は Workers ランタイムが注入する外部境界（fetch の有無で検証済み）
  return binding as ServiceBinding;
}

export function parseRelayEnv(env: Record<string, unknown>): Result<RelayConfig, string> {
  const result = v.safeParse(EnvSchema, env);
  if (result.success) {
    return ok(result.output);
  }
  const details = result.issues
    .map((issue) => `${v.getDotPath(issue) ?? "(不明)"}: ${issue.message}`)
    .join("、");
  return err(`環境変数が不正です — ${details}`);
}
