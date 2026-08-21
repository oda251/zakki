/**
 * E2E 暗号の解除 CLI（issue #133）。
 *   bun run decrypt   … DB をアンロックし、全行を平文へ戻して封筒を消す
 *
 * `migratePlaintextToEncrypted`（暗号 ON にしたときの一括暗号化）の逆で、
 * 暗号を既定 OFF に戻すための移行手段（issue #129 の決定 2）。**暗号のコードは
 * 残る**——`ZAKKI_ENCRYPTION=1` で起動すればまた暗号化できる。
 *
 * 実行後の DB は封筒を持たないので、以後は `ZAKKI_ENCRYPTION` を外して起動する。
 *
 * 秘密（パスフレーズ・DEK・KEK）はログに出さない。
 */
import { ready } from "@zakki/core/crypto/sodium.ts";
import {
  hasEnvelope,
  unlockWithKeyfile,
  unlockWithPassphrase,
} from "@zakki/data/crypto/envelopes.ts";
import {
  applyAadFixups,
  migrateEncryptedToPlaintext,
  provisionCrypto,
} from "@zakki/data/crypto/init.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";
import { createDb, defaultDbPath } from "@zakki/data/db/connect.ts";
import { xdgConfigHome, xdgDataHome } from "@zakki/data/util/paths.ts";
import { loadConfigOrExit } from "@zakki/tui/config.ts";
import { readPassphrase } from "@zakki/tui/tui/prompt.ts";

if (!process.stdout.isTTY) {
  console.error("zakki: 対話端末（TTY）で実行してください");
  process.exit(1);
}

// 合成点: 環境変数を起動時に一度だけ検証する（issue #48）
const config = loadConfigOrExit(process.env);
const configHome = xdgConfigHome(config.xdgConfigHome);

await ready();
const db = await createDb(defaultDbPath(xdgDataHome(config.xdgDataHome)));

if (!(await hasEnvelope(db, "keyfile")) && !(await hasEnvelope(db, "passphrase"))) {
  console.error("zakki: この DB は暗号化されていません（封筒がありません）。何もしません。");
  process.exit(1);
}

// DEK を取り出す: キーファイルが使えれば無言、無理なら現行パスフレーズで。
let dek: Uint8Array | undefined;
if (await hasEnvelope(db, "keyfile")) {
  try {
    dek = await unlockWithKeyfile(db, await loadOrCreateKeyfile(configHome));
  } catch {
    // キーファイル KEK 不一致。パスフレーズへフォールバック。
  }
}
if (dek === undefined) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      dek = await unlockWithPassphrase(db, await readPassphrase("現在のパスフレーズ: "));
      break;
    } catch {
      console.error(
        attempt < 3
          ? "パスフレーズが違います。再試行してください。"
          : "パスフレーズが違います。終了します。",
      );
    }
  }
}
if (dek === undefined) {
  process.exit(1);
}

const ctx = provisionCrypto(db, dek);
// chunk ツリー移行（0010）の AAD 付替え予約が残っていると行ごとに AAD が違う。
// 復号の前に必ず消化する（通常のアンロック経路と同じ順序）。
await applyAadFixups(db, ctx);
// 復号は 1 トランザクション。途中で落ちても中途半端な混在状態にはならない。
await migrateEncryptedToPlaintext(db, ctx);
console.log(
  "平文へ戻しました。封筒とメタは削除済みです。以後は ZAKKI_ENCRYPTION を外して起動してください。",
);
