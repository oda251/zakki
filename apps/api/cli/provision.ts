import { err, ok, type Result } from "neverthrow";
import type { PlatformFailure, TursoPlatform } from "@zakki/core/turso/platform.ts";
import { createTursoPlatform, TURSO_API_BASE_URL } from "@zakki/core/turso/platform.ts";
import { parseProvisionEnv } from "./env.ts";

/**
 * コントロールプレーンのブートストラップ（issue #131）。
 *   bun run provision   … group とコントロールプレーン DB を用意し、接続情報を出力する
 *
 * コントロールプレーン DB は台帳そのもので、**アプリが起動する前に存在していないと
 * いけない**（鶏と卵）。ユーザごとの DB のように実行時プロビジョニングへ畳めるのは
 * 「台帳を引ける」ことが前提なので、ここだけはアプリ外の実行点が要る。
 *
 * Pulumi は使わない（issue #129）: Turso は IaC を提供も推奨もしておらず、非公式
 * プロバイダは現行 API と非互換だった。公式の管理手段は CLI と Platform API だけ。
 *
 * 何度実行しても壊れない（冪等）。ただしトークンは毎回新しく発行する——Platform API に
 * 「発行済みトークンを読み出す」経路が無いため、再取得は再発行と同義になる。
 * 出力したトークンは Worker の secret などへ移し、この端末には残さない。
 */

/** 出力する接続情報。そのまま `KEY=value` として env に流せる形で持つ */
export interface ControlPlaneEndpoint {
  readonly url: string;
  readonly token: string;
}

/**
 * コントロールプレーン DB を存在させる。
 *
 * ユーザ DB 側（`src/turso/provision.ts` の `ensureUserDatabase`）と実装を共有しない
 * のは、あちらが台帳を一次情報とし「作成を先に投げて 409 を畳む」形（リクエスト経路の
 * 往復を減らすため）なのに対し、こちらは台帳より前段で、名前が固定・実行が人手・
 * 頻度が年に数回だから。取得を先に行い「既にある」を素直に成功として扱う。
 */
async function ensureControlDatabase(
  platform: TursoPlatform,
  name: string,
): Promise<Result<string, PlatformFailure>> {
  const found = await platform.getDatabase(name);
  if (found.isErr()) return err(found.error);
  if (found.value !== null) return ok(found.value.hostname);

  const created = await platform.createDatabase(name);
  if (created.isOk()) return ok(created.value.hostname);
  // 409 = 取得と作成の間に他の実行者が作った。もう一度引き当てる
  if (created.error.kind !== "conflict") return err(created.error);
  const again = await platform.getDatabase(name);
  if (again.isErr()) return err(again.error);
  if (again.value === null) {
    return err({ kind: "malformed", detail: `作成済みのはずの DB ${name} を取得できません` });
  }
  return ok(again.value.hostname);
}

/**
 * group → コントロールプレーン DB → DB スコープトークンの順に用意する。
 *
 * トークンは無期限（`expiration: "never"`）で発行する。Worker が常時使う接続情報で、
 * 失効すると認証以前にコントロールプレーン全体が落ちるため。権限は DB スコープの
 * full-access に限られ、組織の他の DB には届かない（組織トークンとの決定的な差）。
 */
export async function provisionControlPlane(
  platform: TursoPlatform,
  controlDbName: string,
  log: (message: string) => void,
): Promise<Result<ControlPlaneEndpoint, PlatformFailure>> {
  const group = await platform.ensureGroup();
  if (group.isErr()) return err(group.error);
  log("group: 用意しました");

  const hostname = await ensureControlDatabase(platform, controlDbName);
  if (hostname.isErr()) return err(hostname.error);
  log(`database ${controlDbName}: 用意しました`);

  const token = await platform.issueToken(controlDbName, {
    expiration: "never",
    authorization: "full-access",
  });
  if (token.isErr()) return err(token.error);
  log("token: 発行しました（この DB のみ・無期限）");

  return ok({ url: `libsql://${hostname.value}`, token: token.value });
}

/** 失敗を人間向けの 1 行にする。detail は Platform API の内部メッセージなので運用ログ限り */
export function describeFailure(failure: PlatformFailure): string {
  switch (failure.kind) {
    case "conflict":
      return "既に存在します";
    case "unreachable":
      return `Turso Platform API へ到達できません: ${failure.detail}`;
    case "status":
      return `Turso Platform API が ${failure.status} を返しました: ${failure.detail}`;
    case "malformed":
      return failure.detail;
    default:
      // switch-exhaustiveness-check が網羅を保証するので到達しない
      return "不明な失敗";
  }
}

if (import.meta.main) {
  // 合成点: 環境変数を起動時に一度だけ検証する（issue #48）
  const config = parseProvisionEnv(process.env).match(
    (c) => c,
    (message): never => {
      console.error(`zakki provision: ${message}`);
      process.exit(1);
    },
  );

  const platform = createTursoPlatform({
    baseUrl: TURSO_API_BASE_URL,
    apiToken: config.apiToken,
    organization: config.organization,
    group: config.group,
    groupLocation: config.groupLocation,
  });

  // 進捗は stderr。stdout は接続情報だけにして `just provision > env` を成立させる
  const result = await provisionControlPlane(platform, config.controlDbName, (m) => {
    console.error(`zakki provision: ${m}`);
  });
  if (result.isErr()) {
    console.error(`zakki provision: ${describeFailure(result.error)}`);
    process.exit(1);
  }
  console.log(`CONTROL_DB_URL=${result.value.url}`);
  console.log(`CONTROL_DB_TOKEN=${result.value.token}`);
}
