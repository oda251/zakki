import type { Hono } from "hono";
import { openRemoteWebDb } from "@zakki/data/db/connect-web.ts";
import { composeRelayApp } from "./relay.ts";
import { ANCO_ASSET_TYPES, ANCO_REF_CACHE, ANCO_REF_FILE, ancoAssetHeaders } from "./anco.ts";
import type { ServiceBinding } from "./worker-env.ts";
import { parseRelayEnv, serviceBinding } from "./worker-env.ts";

/**
 * Cloudflare Workers 用起動アダプタ（issue #134）。
 *
 * 中継サーバをマルチユーザ**専用**で動かす経路。bun 用アダプタ（index.ts）との違いは 3 つ:
 * - ローカル DB を開かない。中継先はリクエストごとにコントロールプレーンが決める
 * - 静的資産（SPA・anco wasm）は Workers Assets が配る。Worker に来るのは
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
  const app = composeRelayApp({
    controlPlaneUrl: config.controlPlaneUrl,
    openUserDb: openRemoteWebDb,
    fetchFn: (input, init) => controlPlane.fetch(input, init),
  });
  apps.set(env, app);
  return app;
}

/**
 * anco アセット（`/anco/*`）を **Worker から**配る（issue #134）。
 *
 * Workers Assets に任せると `Content-Encoding: br` が付かない。それだけでなく、
 * Cloudflare は **既に brotli の中身をさらに転送圧縮する**（実測: `accept-encoding: br`
 * で 13,368,949 bytes・先頭が別物）ので、`_headers` で `Content-Encoding` を宣言しても
 * 転送圧縮の方を指してしまい直らない。結果、ブラウザは 1 段だけ解いた brotli を
 * `WebAssembly.compile` に渡し `expected magic word 00 61 73 6d` で落ちる。
 *
 * 非圧縮で置く手も使えない: 展開後は 53.6 MiB / 26.9 MiB で Assets の 25 MiB 上限を超える。
 *
 * そこで Worker が Assets から**生のバイト**（`accept-encoding: identity`）を取り、
 * bun アダプタと同じヘッダを付けて返す。`Content-Encoding` を自分で付けた応答を
 * Cloudflare は再圧縮しない。
 */
async function serveAnco(assets: ServiceBinding, request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const file = pathname.startsWith("/anco/") ? pathname.slice("/anco/".length) : null;
  if (file === null) return null;

  // Assets からは必ず生のまま取る（ここで encoding が付くと二重になる）
  const raw = await assets.fetch(request.url, { headers: { "accept-encoding": "identity" } });
  if (!raw.ok) return raw;

  if (file === ANCO_REF_FILE) {
    return new Response(raw.body, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": ANCO_REF_CACHE },
    });
  }
  const contentType = ANCO_ASSET_TYPES.get(file);
  if (contentType === undefined) return raw;
  return new Response(raw.body, { headers: ancoAssetHeaders(contentType) });
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const assets = serviceBinding(env, "ASSETS");
    if (assets !== null) {
      const served = await serveAnco(assets, request);
      if (served !== null) return served;
    }
    return await composeApp(env).fetch(request);
  },
};
