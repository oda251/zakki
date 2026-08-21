import type { Hono } from "hono";
import { createApp } from "./app.ts";
import type { RemoteDbResolverOptions, ServerFetchLike } from "./identity/remote.ts";
import { createRemoteDbResolver } from "./identity/remote.ts";

/** 接続情報から DB を開くアダプタ（ランタイムごとに差し替える点） */
type OpenUserDb = RemoteDbResolverOptions["openUserDb"];

/**
 * マルチユーザ専用の中継アプリを組む（issue #134）。ローカル DB を開かない。
 *
 * Workers 配備で使う。`bootstrapServer` と違ってファイルシステムに触れず、DB を
 * 開くのはリクエスト単位の解決器だけ——つまり `openUserDb` に何を渡すかで
 * ランタイムが決まる（Workers なら `openRemoteWebDb`）。ここ自体は
 * ランタイム非依存なので、テストからも同じ形で組める。
 *
 * 単一ユーザ用のフォールバック DB は渡さない。未ログインのリクエストは中継先が
 * 決まらず 401 になる（`dbForRequest` が null を返す）。
 */
export function composeRelayApp(options: {
  controlPlaneUrl: string;
  openUserDb: OpenUserDb;
  fetchFn?: ServerFetchLike;
}): Hono {
  const { controlPlaneUrl, openUserDb, fetchFn } = options;
  return createApp({
    controlPlaneUrl,
    resolveDb: createRemoteDbResolver({ controlPlaneUrl, openUserDb, fetchFn }),
  });
}
