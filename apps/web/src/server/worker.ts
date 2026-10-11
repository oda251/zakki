import type { Hono } from "hono";
import { openRemoteWebDb } from "@zakki/data/db/connect-web.ts";
import { r2FileStore } from "./files/store.ts";
import { composeRelayApp } from "./relay.ts";
import { parseRelayEnv, r2BucketBindings, serviceBinding } from "./worker-env.ts";

/**
 * Cloudflare Workers 用起動アダプタ（issue #134）。
 *
 * 中継サーバをマルチユーザ**専用**で動かす経路。bun 用アダプタ（index.ts）との違いは 3 つ:
 * - ローカル DB を開かない。中継先はリクエストごとにコントロールプレーンが決める
 * - 静的資産（SPA）は Workers Assets が配る。Worker に来るのは
 *   Assets に無いパス、つまり `/api/*` だけになる（wrangler.jsonc の
 *   `assets.not_found_handling: "single-page-application"` + `run_worker_first`）
 * - 環境変数は fetch の第 2 引数で渡る（Workers に process 環境は無い）
 * - コントロールプレーンへの問い合わせは **Service Binding**（`CONTROL_PLANE`）を通す。
 *   公開 URL を Worker から fetch すると自分自身へループバックする（worker-env.ts の注記）
 *
 * 単一ユーザ self-host は従来どおり bun / docker で動く。こちらを消すものではない。
 *
 * Workers ランタイム制約により node 組込み・Bun 固有 API は使わない。
 * `@zakki/data` からも Workers 可搬な `db/connect-web.ts` だけを引く
 * （`db/connect.ts` は node:fs 依存）。
 */
const apps = new WeakMap<object, Hono>();

function composeApp(env: Record<string, unknown>): Hono {
  const cached = apps.get(env);
  if (cached !== undefined) {
    return cached;
  }
  // 検証失敗はハンドラ内で 500 を合成せず明示エラーとして throw する
  // （設定不備 = 起動失敗を、稼働中のリクエスト起因エラーと区別する）
  const config = parseRelayEnv(env).match(
    (c) => c,
    (message): never => {
      throw new Error(`zakki-web: ${message}`);
    },
  );
  // コントロールプレーンへの問い合わせは Service Binding を通す。公開 URL を
  // Worker から fetch すると自分自身へループバックする（worker-env.ts の注記）。
  // binding が無い配備は「静かに 401 を返し続ける」ので、起動失敗にして気づけるようにする
  const controlPlane = serviceBinding(env, "CONTROL_PLANE");
  if (controlPlane === null) {
    throw new Error(
      "zakki-web: Service Binding CONTROL_PLANE がありません（wrangler.jsonc の services を確認してください）",
    );
  }
  const buckets = r2BucketBindings(env);
  if (buckets === null) {
    throw new Error(
      "zakki-web: R2 bindings FILES_PERMANENT, FILES_1D, FILES_7D, FILES_30D がすべて必要です（wrangler.jsonc の r2_buckets を確認してください）",
    );
  }
  const app = composeRelayApp({
    controlPlaneUrl: config.controlPlaneUrl,
    openUserDb: openRemoteWebDb,
    fetchFn: (input, init) => controlPlane.fetch(input, init),
    files: r2FileStore(buckets),
  });
  apps.set(env, app);
  return app;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    return await composeApp(env).fetch(request);
  },
};
