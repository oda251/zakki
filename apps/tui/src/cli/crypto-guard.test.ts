/**
 * CLI エントリの暗号ガード / keyfile 無言アンロック検証（issue #64 / #93）。
 *
 * digest / stats / normalize-tags は createDb で DB を直接開くため、暗号 ON で
 * 初期化した DB をアンロックなしで開くと暗号文を平文として読み書きする穴があった。
 * ここでは一時 XDG ディレクトリに暗号 ON の DB を作り、CLI を subprocess 実行して
 * - 未アンロック（ZAKKI_ENCRYPTION 未設定）: データアクセス前に非ゼロ終了 + 明示エラー
 * - ZAKKI_ENCRYPTION=1 + keyfile 一致: 無言アンロックして復号済みデータで動作
 * - ZAKKI_ENCRYPTION=1 + keyfile なし/不一致: データアクセス前に非ゼロ終了 + 明示エラー
 * を検証する。外部依存（Ollama / embedding）は無効化してあり brittle にならない。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { getOrCreateDateChunk, saveChildren } from "@zakki/data/chunk/repository.ts";
import { defaultDbPath, migrateDb, openClient } from "@zakki/data/db/connect.ts";
import { initCrypto } from "@zakki/data/crypto/init.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";

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
 * seed 用に DB を開く。subprocess 実行前に client.close() でハンドルを閉じ、
 * 親プロセスの接続が残ったままによる SQLITE_BUSY を避ける。
 */
async function openSeedDb(dataHome: string): Promise<Awaited<ReturnType<typeof openClient>>> {
  const { client, db } = await openClient(defaultDbPath(dataHome));
  await migrateDb(db);
  return { client, db };
}

/**
 * CLI を subprocess 実行する。環境変数は最小構成で明示し、親プロセスの
 * ZAKKI_* 設定（暗号・Turso・LLM 等）が漏れ込まないようにする。
 * configHome を渡すとその XDG_CONFIG_HOME（= keyfile の置き場）を使う。
 */
async function runCli(
  script: (typeof CLIS)[number],
  dataHome: string,
  options: { encryption?: boolean; configHome?: string; args?: string[] } = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const vaultDir = mkdtempSync(join(tmpdir(), "zakki-cli-vault-"));
  const proc = Bun.spawn(
    ["bun", join(repoRoot, "apps", "tui", "src", "cli", script), ...(options.args ?? [])],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: options.configHome ?? mkdtempSync(join(tmpdir(), "zakki-cli-config-")),
        ZAKKI_VAULT_DIR: vaultDir,
        ...(options.encryption === true ? { ZAKKI_ENCRYPTION: "1" } : {}),
        // embedding / LLM 自動検出は外部依存なので無効化・非到達アドレスに固定する
        ZAKKI_NO_EMBEDDING: "1",
        ZAKKI_LLM_BASE_URL: "http://127.0.0.1:1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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
    const { client, db } = await openSeedDb(dataHome);
    await initCrypto(db, sodium.randombytes_buf(32));
    client.close();

    for (const script of CLIS) {
      const { exitCode, stderr } = await runCli(script, dataHome);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("ZAKKI_ENCRYPTION=1");
    }
  }, 60_000);

  test("暗号 OFF の DB（封筒なし）では stats が従来どおり動作する", async () => {
    const dataHome = tempDataHome();
    // 平文 DB を用意（マイグレーションのみ・封筒なし）
    (await openSeedDb(dataHome)).client.close();

    const { exitCode, stdout, stderr } = await runCli("stats.ts", dataHome);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("気分の推移");
  }, 60_000);
});

describe("CLI keyfile 無言アンロック（issue #93）", () => {
  test("暗号 ON DB + keyfile 一致: ZAKKI_ENCRYPTION=1 で各 CLI が復号済みデータで動作する", async () => {
    const dataHome = tempDataHome();
    const configHome = mkdtempSync(join(tmpdir(), "zakki-cli-keyfile-"));
    // keyfile を配置し、その KEK で暗号 ON DB を初期化 → 暗号化済みチャンクを書く
    const kek = await loadOrCreateKeyfile(configHome);
    const { client, db } = await openSeedDb(dataHome);
    await initCrypto(db, kek);
    const date = "2026-07-01";
    const parent = (await getOrCreateDateChunk(db, date))._unsafeUnwrap();
    (await saveChildren(db, parent.id, [{ content: "散歩して気分がよかった" }]))._unsafeUnwrap();
    client.close();

    // digest は復号済み本文（タイトル）を出力に含む = 平文フォールバックでない証拠
    const digest = await runCli("digest.ts", dataHome, {
      encryption: true,
      configHome,
      args: [date],
    });
    expect(digest.stderr).toBe("");
    expect(digest.exitCode).toBe(0);
    expect(digest.stdout).toContain("散歩して気分がよかった");

    const stats = await runCli("stats.ts", dataHome, { encryption: true, configHome });
    expect(stats.stderr).toBe("");
    expect(stats.exitCode).toBe(0);
    expect(stats.stdout).toContain(date);

    const tags = await runCli("normalize-tags.ts", dataHome, { encryption: true, configHome });
    expect(tags.stderr).toBe("");
    expect(tags.exitCode).toBe(0);
  }, 60_000);

  test("暗号 ON DB + keyfile なし/不一致: 各 CLI がデータアクセス前に明示エラーで停止する", async () => {
    const dataHome = tempDataHome();
    // DB の封筒はこの KEK で wrap される。subprocess には別の（空の）XDG_CONFIG_HOME を
    // 渡すため keyfile は新規生成され、封筒と一致しない
    const { client, db } = await openSeedDb(dataHome);
    await initCrypto(db, sodium.randombytes_buf(32));
    client.close();

    for (const script of CLIS) {
      const { exitCode, stderr } = await runCli(script, dataHome, { encryption: true });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("アンロックに失敗");
    }
  }, 60_000);
});
