import { resolveDefaultEngine } from "@zakki/backend/anco/engine.ts";
import { resolveDefaultEmbedder } from "@zakki/backend/embedding/embedder.ts";
import { openDb } from "@zakki/data/db/connect.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";
import { unlockOrSetup } from "@zakki/data/crypto/unlock.ts";
import { resolveLocalIdentity } from "@zakki/data/identity/local.ts";
import { createAnalysisScheduler } from "./analysis.ts";
import { createApp } from "./app.ts";

// TUI（apps/tui/src/index.tsx）と同じ合成: openDb → 暗号アンロック → エンジン選択 → serve。
// 違いは 2 点: TTY を要求しない・暗号はキーファイルの無言アンロックのみ
// （初回セットアップ・パスフレーズ入力は対話 UI を持つ TUI 側で行う）。
const identity = resolveLocalIdentity();
const { db, sync } = await openDb(identity);

if (process.env["ZAKKI_ENCRYPTION"] === "1") {
  const keyfileKek = await loadOrCreateKeyfile();
  const headless = (what: string) => () =>
    Promise.reject(
      new Error(`web サーバは${what}に対応していません。先に TUI（bun start）で実行してください`),
    );
  try {
    await unlockOrSetup(db, keyfileKek, {
      newPassphrase: headless("初回セットアップ"),
      passphrase: headless("パスフレーズ入力"),
      showRecoveryCode: headless("リカバリコード表示"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`zakki-web: アンロックに失敗しました（${msg}）`);
    process.exit(1);
  }
}

await sync();

const engine = resolveDefaultEngine();
const embedder = resolveDefaultEmbedder();

const analysis = createAnalysisScheduler(db, embedder, (m) => console.error(`zakki-web: ${m}`));
const app = createApp({ db, engine, embedder, analysis });

const port = Number(process.env["ZAKKI_WEB_PORT"] ?? 3777);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`zakki-web: http://localhost:${server.port} (engine: ${engine.name})`);
