import type { Hono } from "hono";
import { resolveDefaultEngine } from "@zakki/backend/anco/engine.ts";
import { resolveDefaultEmbedder } from "@zakki/backend/embedding/embedder.ts";
import type { ZakkiConfig } from "@zakki/core/config/env.ts";
import { assertCryptoReady } from "@zakki/data/crypto/guard.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";
import { unlockOrSetup } from "@zakki/data/crypto/unlock.ts";
import { defaultDbPath, openDb } from "@zakki/data/db/connect.ts";
import { resolveLocalIdentity } from "@zakki/data/identity/local.ts";
import { xdgConfigHome, xdgDataHome } from "@zakki/data/util/paths.ts";
import { createAnalysisScheduler } from "./analysis.ts";
import { createApp } from "./app.ts";
import { createAnalysisEvents } from "./events.ts";

const headless = (what: string) => () =>
  Promise.reject(
    new Error(`web サーバは${what}に対応していません。先に TUI（bun start）で実行してください`),
  );

/**
 * API サーバの合成（issue #29）。検証済み config を受け取り、標準 Fetch ハンドラ
 * （Hono アプリ）を返す。Bun 固有 API（Bun.serve・hono/bun の静的配信）は使わず、
 * それらは起動アダプタ（index.ts）に隔離する。
 *
 * TUI（apps/tui/src/index.tsx）と同じ合成: openDb → 暗号アンロック → guard →
 * sync → エンジン選択。違いは 2 点: TTY を要求しない・暗号はキーファイルの無言
 * アンロックのみ（初回セットアップ・パスフレーズ入力は対話 UI を持つ TUI 側で行う）。
 */
export async function bootstrapServer(
  config: ZakkiConfig,
): Promise<{ app: Hono; engineName: string }> {
  const dataHome = xdgDataHome(config.xdgDataHome);
  const configHome = xdgConfigHome(config.xdgConfigHome);

  const identity = resolveLocalIdentity(config, configHome);
  const { db, sync } = await openDb(identity, defaultDbPath(dataHome));

  if (config.encryption) {
    const keyfileKek = await loadOrCreateKeyfile(configHome);
    try {
      await unlockOrSetup(db, keyfileKek, {
        newPassphrase: headless("初回セットアップ"),
        passphrase: headless("パスフレーズ入力"),
        showRecoveryCode: headless("リカバリコード表示"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`アンロックに失敗しました（${msg}）`, { cause: err });
    }
  }

  // 暗号 ON で作成した DB を ZAKKI_ENCRYPTION 未設定で開くと、暗号文をそのまま
  // 平文として読み書きしてしまう（issue #46）。データアクセス前に拒否する。
  // アンロック済み・暗号 OFF（封筒なし）の DB では no-op。
  await assertCryptoReady(db);

  await sync();

  const engine = resolveDefaultEngine(config, dataHome);
  const embedder = resolveDefaultEmbedder(config.noEmbedding);

  const events = createAnalysisEvents();
  const analysis = createAnalysisScheduler(
    db,
    embedder,
    (m) => console.error(`zakki-web: ${m}`),
    undefined,
    () => events.emit(),
  );
  const app = createApp({ db, engine, embedder, analysis, events });
  return { app, engineName: engine.name };
}
