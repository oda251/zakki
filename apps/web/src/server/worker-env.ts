import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

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
