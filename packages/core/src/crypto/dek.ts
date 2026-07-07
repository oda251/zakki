import { decrypt, encrypt } from "@zakki/core/crypto/aead.ts";
import { sodium } from "@zakki/core/crypto/sodium.ts";

/**
 * 封筒（envelope）方式のデータ暗号鍵（DEK）管理。
 *
 * 全フィールドを実際に暗号化する DEK は一度だけランダム生成し、それを
 * 各種 KEK（鍵暗号鍵）で AEAD 暗号化した「封筒」として保管する。
 *
 * 1 つの DEK に対して **複数の封筒** を持てる（キーファイル / パスフレーズ /
 * リカバリコードなど、それぞれ別の KEK から作る独立した {@link wrapDek} 出力）。
 * これにより、DEK 自体を再生成せずにアンロック手段を追加・失効できる。
 * Phase 6 でパスフレーズ封筒・リカバリ封筒を追加する。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} を完了させておくこと。
 */

/**
 * DEK の鍵長（バイト）。XChaCha20-Poly1305 の鍵長（`crypto_aead_xchacha20poly1305_ietf_KEYBYTES`
 * = 32）に一致する。DEK を包む KEK（keyfile / パスフレーズ由来）も同じ AEAD を使うため
 * 同一長（kdf.ts の導出長・keyfile の生成長がこれを参照する）。
 */
export const DEK_BYTES = 32;

/** ランダムな {@link DEK_BYTES} バイトの DEK を生成する。 */
export function generateDek(): Uint8Array {
  return sodium.randombytes_buf(DEK_BYTES);
}

/**
 * DEK を KEK で AEAD 暗号化し、封筒（`nonce || ciphertext`）を返す。
 *
 * @param dek 包む対象の DEK（32 バイト）
 * @param kek 鍵暗号鍵（32 バイト）
 */
export function wrapDek(dek: Uint8Array, kek: Uint8Array): Uint8Array {
  return encrypt(kek, dek);
}

/**
 * 封筒を KEK で復号して DEK を取り出す。
 *
 * KEK が誤っている場合は AEAD 認証に失敗して **例外を投げる**。
 * Phase 6 ではこの失敗をもって「パスフレーズ違い」を検出する。
 *
 * @throws KEK 違い・封筒の改竄時
 */
export function unwrapDek(envelope: Uint8Array, kek: Uint8Array): Uint8Array {
  return decrypt(kek, envelope);
}
