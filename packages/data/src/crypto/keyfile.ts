import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEK_BYTES } from "@zakki/core/crypto/dek.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { APP_DIR } from "@zakki/data/util/paths.ts";

/**
 * ローカルキーファイルによる KEK（鍵暗号鍵）管理（Phase 5 の唯一のアンロック手段）。
 *
 * `$XDG_CONFIG_HOME/zakki/keyfile` に 32 バイトのランダム KEK を保管する。
 * これは封筒（wrapped DEK）を開くための鍵であり、DEK そのものではない。
 * Phase 6 でパスフレーズ封筒・リカバリ封筒を同じ DEK に追加する。
 *
 * KEK の中身は **絶対にログ出力しない**。
 */

// KEK は DEK と同じ AEAD（XChaCha20-Poly1305）の鍵なので、長さも DEK_BYTES（32）と同一。
const KEYFILE_BYTES = DEK_BYTES;

/** keyfile のパス（`<configHome>/zakki/keyfile`）。configHome は解決済み XDG 設定ディレクトリ */
export function keyfilePath(configHome: string): string {
  return join(configHome, APP_DIR, "keyfile");
}

/**
 * keyfile を読み出す。無ければ 32 バイトをランダム生成し、0600 で書き出す
 * （ディレクトリは 0700 で作成）。返り値は 32 バイトの KEK。
 *
 * 複数回呼んでも同じ KEK を返す（生成は初回のみ）。
 * configHome は合成点が検証済み config から解決して渡す。
 */
export async function loadOrCreateKeyfile(configHome: string): Promise<Uint8Array> {
  await ready();
  const path = keyfilePath(configHome);
  if (existsSync(path)) {
    const buf = readFileSync(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  mkdirSync(join(configHome, APP_DIR), { recursive: true, mode: 0o700 });
  const kek = sodium.randombytes_buf(KEYFILE_BYTES);
  writeFileSync(path, kek, { mode: 0o600 });
  return kek;
}
