/**
 * CLI エントリの暗号ガード検証（issue #64）。
 *
 * digest / stats / normalize-tags は createDb で DB を直接開くため、暗号 ON で
 * 初期化した DB をアンロックなしで開くと暗号文を平文として読み書きする穴があった。
 * ここでは一時 XDG ディレクトリに暗号 ON の DB を作り、CLI を subprocess 実行して
 * 「データアクセス前に非ゼロ終了 + 明示エラー」になることを検証する。
 * 外部依存（Ollama / embedding）に到達する前にガードで止まるため brittle にならない。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb, defaultDbPath } from "@zakki/data/db/connect.ts";
import { initCrypto } from "@zakki/data/crypto/init.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const CLIS = ["digest.ts", "stats.ts", "normalize-tags.ts"] as const;

beforeAll(async () => {
  await ready();
});

/** 一時 XDG データディレクトリ（DB は defaultDbPath の実配置と同じ相対位置に作る） */
function tempDataHome(): string {
  return mkdtempSync(join(tmpdir(), "zakki-cli-guard-"));
}

/**
 * CLI を subprocess 実行する。環境変数は最小構成で明示し、親プロセスの
 * ZAKKI_* 設定（暗号・Turso・LLM 等）が漏れ込まないようにする。
 */
async function runCli(
  script: (typeof CLIS)[number],
  dataHome: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const vaultDir = mkdtempSync(join(tmpdir(), "zakki-cli-vault-"));
  const proc = Bun.spawn(["bun", join(repoRoot, "apps", "tui", "src", "cli", script)], {
    cwd: repoRoot,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "zakki-cli-config-")),
      ZAKKI_VAULT_DIR: vaultDir,
      // embedding / LLM 自動検出は外部依存なので無効化・非到達アドレスに固定する
      ZAKKI_NO_EMBEDDING: "1",
      ZAKKI_LLM_BASE_URL: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("CLI 暗号ガード（issue #64）", () => {
  test("暗号 ON の DB を ZAKKI_ENCRYPTION 未設定で開くと、各 CLI がデータアクセス前に停止する", async () => {
    const dataHome = tempDataHome();
    // 暗号 ON で初期化（key_envelopes に封筒を作る）。subprocess は別ハンドルで
    // 開き直すため CryptoContext は引き継がれず、「アンロックなしの再オープン」になる
    const db = await createDb(defaultDbPath(dataHome));
    await initCrypto(db, sodium.randombytes_buf(32));

    for (const script of CLIS) {
      const { exitCode, stderr } = await runCli(script, dataHome);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("ZAKKI_ENCRYPTION=1");
    }
  }, 60_000);

  test("暗号 OFF の DB（封筒なし）では stats が従来どおり動作する", async () => {
    const dataHome = tempDataHome();
    // 平文 DB を用意（マイグレーションのみ・封筒なし）
    await createDb(defaultDbPath(dataHome));

    const { exitCode, stdout, stderr } = await runCli("stats.ts", dataHome);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("気分の推移");
  }, 60_000);
});
