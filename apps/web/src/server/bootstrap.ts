import type { Hono } from "hono";
import type { ZakkiConfig } from "@zakki/core/config/env.ts";
import { defaultDbPath, openDb } from "@zakki/data/db/connect.ts";
import { resolveLocalIdentity } from "@zakki/data/identity/local.ts";
import { xdgConfigHome, xdgDataHome } from "@zakki/data/util/paths.ts";
import { createApp } from "./app.ts";

/**
 * API サーバの合成（issue #29）。検証済み config を受け取り、標準 Fetch ハンドラ
 * （Hono アプリ）を返す。Bun 固有 API（serve・静的配信）は使わず、それらは
 * bun 用起動アダプタ（index.ts）に隔離する（scripts/check-arch-guards.sh Guard 3）。
 *
 * web サーバは DEK を一切持たない（#45 / #28 項目1）:
 * - 暗号アンロック（keyfile unlock）・assertCryptoReady は撤去。復号・平文の
 *   読み書きはクライアント（RxDB replication + FieldCrypto）と TUI の責務で、
 *   サーバは暗号文の中継（replication / 封筒配布）と変換エンジンのみを提供する。
 *   ZAKKI_ENCRYPTION はサーバでは参照しない（TUI 専用。暗号 ON かどうかは
 *   クライアントが封筒の有無で判定する）。
 * - assertCryptoReady（issue #46 のサイレント平文読みガード）が守っていた危険
 *   経路（chunk/graph の復号読み・平文書込みルート）自体が撤去されたため、
 *   ガードも不要になった。残る DB アクセスは repl_docs（暗号文 JSON）・
 *   key_envelopes（公開可能な封筒）・conversion_cache / corrections（従来から
 *   平文のテーブル）のみ。
 * - 解析（tagger / linker / sentiment / embedder）は平文前提のためサーバから
 *   撤去（クライアント移設は #28/#26 の別トラック。TUI ではローカル平文の
 *   世界としてそのまま動き続ける）。
 */
export async function bootstrapServer(config: ZakkiConfig): Promise<{ app: Hono }> {
  const dataHome = xdgDataHome(config.xdgDataHome);
  const configHome = xdgConfigHome(config.xdgConfigHome);

  const identity = resolveLocalIdentity(config, configHome);
  const { db, sync } = await openDb(identity, defaultDbPath(dataHome));

  // 起動時の同期はベストエフォート（オフライン・未設定は正常系）。
  // サーバは解析を持たないため、増分解析スナップショットの破棄（issue #55 の
  // syncWithAnalysisReset）も不要になった。
  await sync();

  return { app: createApp({ db }) };
}
