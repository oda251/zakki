import { createApp } from "./app.ts";
import { createControlDb } from "./db/client.ts";
import { parseApiEnv } from "./env.ts";

/**
 * Cloudflare Workers エントリ（issue #99）。
 *
 * Workers に Node 的なプロセス環境変数は無く、env は fetch の第2引数で渡る。
 * 最初のリクエスト
 * で一度だけ検証・合成し、env オブジェクト（isolate 内で同一参照）単位で
 * memoize する。検証失敗はハンドラ内で 500 を合成せず明示エラーとして throw
 * する（設定不備 = 起動失敗を、稼働中のリクエスト起因エラーと区別する）。
 *
 * Workers ランタイム制約: このファイルを含む apps/api/src は node 組み込み・
 * Bun 固有 API を使わない（Web 標準のみ。scripts/check-arch-guards.sh Guard 5 /
 * depcruise api-control-plane-standalone で機械的に担保）。
 */
const apps = new WeakMap<object, ReturnType<typeof createApp>>();

function composeApp(env: Record<string, unknown>): ReturnType<typeof createApp> {
  const cached = apps.get(env);
  if (cached !== undefined) {
    return cached;
  }
  const config = parseApiEnv(env).match(
    (c) => c,
    (message): never => {
      throw new Error(`zakki-api: ${message}`);
    },
  );
  const db = createControlDb({ url: config.controlDbUrl, authToken: config.controlDbToken });
  const app = createApp({ db });
  apps.set(env, app);
  return app;
}

export default {
  fetch(request: Request, env: Record<string, unknown>): Response | Promise<Response> {
    return composeApp(env).fetch(request);
  },
};
