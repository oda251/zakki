/**
 * パスフレーズ変更 CLI（Phase 6）。
 *   bun run passphrase   … DB を開き、アンロックしてからパスフレーズ封筒だけを差し替える
 *
 * アンロックはキーファイル KEK の無言アンロックを優先し、使えなければ現行パスフレーズを
 * 尋ねる。パスフレーズ変更は封筒の再 wrap のみで、データ行の再暗号化は一切行わない
 * （DEK は不変）。キーファイル・リカバリ封筒は影響を受けない。
 *
 * 秘密（パスフレーズ・DEK・KEK）はログに出さない。
 */
import { ready } from "@zakki/core/crypto/sodium.ts";
import {
  changePassphrase,
  unlockWithKeyfile,
  unlockWithPassphrase,
} from "@zakki/data/crypto/envelopes.ts";
import { hasEnvelope } from "@zakki/data/crypto/envelopes.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";
import { createDb, defaultDbPath } from "@zakki/data/db/connect.ts";
import { xdgConfigHome, xdgDataHome } from "@zakki/data/util/paths.ts";
import { loadConfigOrExit } from "@zakki/tui/config.ts";
import { readNewPassphraseTwice, readPassphrase } from "@zakki/tui/tui/prompt.ts";

if (!process.stdout.isTTY) {
  console.error("zakki: 対話端末（TTY）で実行してください");
  process.exit(1);
}

// 合成点: 環境変数を起動時に一度だけ検証する（issue #48）
const config = loadConfigOrExit(process.env);
const configHome = xdgConfigHome(config.xdgConfigHome);

await ready();
const db = await createDb(defaultDbPath(xdgDataHome(config.xdgDataHome)));

if (!(await hasEnvelope(db, "passphrase"))) {
  console.error(
    "zakki: パスフレーズ封筒がありません（先に ZAKKI_ENCRYPTION=1 で起動して初期化してください）",
  );
  process.exit(1);
}

// 現行 DEK を取り出す: キーファイルが使えれば無言、無理なら現行パスフレーズで。
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

const next = await readNewPassphraseTwice();
await changePassphrase(db, dek, next);
console.log("パスフレーズを変更しました（データの再暗号化はありません）。");
