import { ready } from "@zakki/core/crypto/sodium.ts";
import { listEnvelopeKinds, unlockWithKeyfile } from "@zakki/data/crypto/envelopes.ts";
import { assertCryptoReady } from "@zakki/data/crypto/guard.ts";
import { applyAadFixups, provisionCrypto } from "@zakki/data/crypto/init.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { xdgConfigHome } from "@zakki/data/util/paths.ts";

/**
 * CLI（digest / stats / normalize-tags）共通の暗号アンロック + ガード（issue #93）。
 *
 * これらの CLI は非対話バッチ用途（cron 等）があるため、TUI の `unlockOrSetup` と違い
 * パスフレーズプロンプトは出さず、**keyfile KEK による無言アンロックのみ** を試みる。
 * 初回セットアップ（DEK 生成・リカバリコード表示）も対話フローの責務なので行わない。
 *
 * 挙動:
 * - `ZAKKI_ENCRYPTION=1` かつ封筒あり: keyfile 封筒を KEK で開いて CryptoContext を
 *   登録する。keyfile が無い・一致しない場合は明示エラーで exit 1。
 * - `ZAKKI_ENCRYPTION=1` かつ封筒なし（未初期化の平文 DB）: 何もしない（平文のまま。
 *   初期化は TUI 起動時に行われる）。
 * - 最後に必ず {@link assertCryptoReady} を通す。暗号 ON DB を `ZAKKI_ENCRYPTION`
 *   未設定で開いた場合はここが止める（issue #64 の挙動を維持）。
 *
 * 秘密（KEK / DEK）はログに出さない。
 */
export async function unlockCliOrExit(
  db: Db,
  config: { encryption: boolean; xdgConfigHome?: string | undefined },
): Promise<void> {
  if (config.encryption) {
    await ready();
    const kinds = await listEnvelopeKinds(db);
    if (kinds.length > 0) {
      if (!kinds.includes("keyfile")) {
        console.error(
          "zakki: keyfile 封筒がないため CLI ではアンロックできません。先に TUI（ZAKKI_ENCRYPTION=1）でこのデバイスをアンロックしてください",
        );
        process.exit(1);
      }
      try {
        const kek = await loadOrCreateKeyfile(xdgConfigHome(config.xdgConfigHome));
        const ctx = provisionCrypto(db, await unlockWithKeyfile(db, kek));
        // chunk ツリー移行（0010）が旧 AAD のまま残した暗号文があれば付替える（冪等）
        await applyAadFixups(db, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `zakki: keyfile によるアンロックに失敗しました（${msg}）。keyfile がこの DB と一致しない可能性があります。CLI はパスフレーズ入力を行わないため、TUI（ZAKKI_ENCRYPTION=1）でアンロックできるか確認してください`,
        );
        process.exit(1);
      }
    }
  }
  // 暗号 ON で作成した DB をアンロックなしで開くと、暗号文をそのまま平文として
  // 読み書きしてしまう（issue #64）。データアクセス前に拒否する。
  // アンロック済み・暗号 OFF（封筒なし）の DB では no-op。
  try {
    await assertCryptoReady(db);
  } catch (err) {
    console.error(`zakki: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
