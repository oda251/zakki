import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "hono/bun";
import { resolveDefaultEngine } from "@zakki/backend/anco/engine.ts";
import { resolveDefaultEmbedder } from "@zakki/backend/embedding/embedder.ts";
import { openDb } from "@zakki/data/db/connect.ts";
import { assertCryptoReady } from "@zakki/data/crypto/guard.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";
import { unlockOrSetup } from "@zakki/data/crypto/unlock.ts";
import { resolveLocalIdentity } from "@zakki/data/identity/local.ts";
import { createAnalysisScheduler } from "./analysis.ts";
import { createApp } from "./app.ts";
import { createAnalysisEvents } from "./events.ts";

// TUI（apps/tui/src/index.tsx）と同じ合成: openDb → 暗号アンロック → エンジン選択 → serve。
// 違いは 2 点: TTY を要求しない・暗号はキーファイルの無言アンロックのみ
// （初回セットアップ・パスフレーズ入力は対話 UI を持つ TUI 側で行う）。
const identity = resolveLocalIdentity();
const { db, sync } = await openDb(identity);

const headless = (what: string) => () =>
  Promise.reject(
    new Error(`web サーバは${what}に対応していません。先に TUI（bun start）で実行してください`),
  );

if (process.env["ZAKKI_ENCRYPTION"] === "1") {
  const keyfileKek = await loadOrCreateKeyfile();
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

// 暗号 ON で作成した DB を ZAKKI_ENCRYPTION 未設定で開くと、暗号文をそのまま
// 平文として読み書きしてしまう（issue #46）。データアクセス前に拒否する。
// アンロック済み・暗号 OFF（封筒なし）の DB では no-op。
try {
  await assertCryptoReady(db);
} catch (err) {
  console.error(`zakki-web: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

await sync();

const engine = resolveDefaultEngine();
const embedder = resolveDefaultEmbedder();

const events = createAnalysisEvents();
const analysis = createAnalysisScheduler(
  db,
  embedder,
  (m) => console.error(`zakki-web: ${m}`),
  undefined,
  () => events.emit(),
);
const app = createApp({ db, engine, embedder, analysis, events });

// ビルド済み SPA（vite build → apps/web/dist）があれば配信する（SPA フォールバック付き）。
// 開発時は dist が無くてもよい（vite dev サーバが /api を proxy する）。
// serveStatic の root は cwd 相対のため、import.meta.url 起点で cwd 非依存に解決する。
const distDir = fileURLToPath(new URL("../../dist", import.meta.url));
if (existsSync(join(distDir, "index.html"))) {
  const root = relative(process.cwd(), distDir);
  app.get("/assets/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

const port = Number(process.env["ZAKKI_WEB_PORT"] ?? 3777);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`zakki-web: http://localhost:${server.port} (engine: ${engine.name})`);
