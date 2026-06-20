import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { xdgConfigHome } from "@zakki/data/util/paths.ts";

/**
 * ローカルキーファイルによる KEK（鍵暗号鍵）管理（Phase 5 の唯一のアンロック手段）。
 *
 * `$XDG_CONFIG_HOME/zakki/keyfile` に 32 バイトのランダム KEK を保管する。
 * これは封筒（wrapped DEK）を開くための鍵であり、DEK そのものではない。
 * Phase 6 でパスフレーズ封筒・リカバリ封筒を同じ DEK に追加する。
 *
 * KEK の中身は **絶対にログ出力しない**。
 */

const KEYFILE_BYTES = 32;

/** keyfile のパス（`$XDG_CONFIG_HOME/zakki/keyfile`） */
export function keyfilePath(): string {
  return join(xdgConfigHome(), "zakki", "keyfile");
}

/**
 * keyfile を読み出す。無ければ 32 バイトをランダム生成し、0600 で書き出す
 * （ディレクトリは 0700 で作成）。返り値は 32 バイトの KEK。
 *
 * 複数回呼んでも同じ KEK を返す（生成は初回のみ）。
 */
export async function loadOrCreateKeyfile(): Promise<Uint8Array> {
  await ready();
  const path = keyfilePath();
  if (existsSync(path)) {
    const buf = readFileSync(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  mkdirSync(join(xdgConfigHome(), "zakki"), { recursive: true, mode: 0o700 });
  const kek = sodium.randombytes_buf(KEYFILE_BYTES);
  writeFileSync(path, kek, { mode: 0o600 });
  return kek;
}
