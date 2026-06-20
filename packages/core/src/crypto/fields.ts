import { decrypt, encrypt } from "@zakki/core/crypto/aead.ts";
import { sodium } from "@zakki/core/crypto/sodium.ts";

/**
 * data 層（Phase 5b）が使うフィールド単位の暗号ヘルパー。
 *
 * 文字列は base64 テキスト列へ、ベクトルは BLOB 用の生バイト列へ暗号化する。
 * `aad`（付加認証データ）に {@link aad} で作るフィールドラベルを渡すことで、
 * 暗号文をそのフィールドに束縛できる（例: chunk.content の暗号文を別フィールドへ
 * 流用する改竄を検出）。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} を完了させておくこと。
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 文脈ラベル（例: "chunk.content"）を UTF-8 バイト列へ符号化し、aad として使う。 */
export function aad(context: string): Uint8Array {
  return enc.encode(context);
}

/** 文字列を UTF-8 で暗号化し、base64（ORIGINAL バリアント）文字列を返す。 */
export function encryptString(key: Uint8Array, s: string, aadBytes?: Uint8Array): string {
  const blob = encrypt(key, enc.encode(s), aadBytes);
  return sodium.to_base64(blob, sodium.base64_variants.ORIGINAL);
}

/** {@link encryptString} の逆操作。base64 文字列を復号して UTF-8 文字列を返す。 */
export function decryptString(key: Uint8Array, b64: string, aadBytes?: Uint8Array): string {
  const blob = sodium.from_base64(b64, sodium.base64_variants.ORIGINAL);
  return dec.decode(decrypt(key, blob, aadBytes));
}

/**
 * Float32 ベクトルを暗号化し、BLOB 格納用の生バイト列（`nonce || ciphertext`）を返す。
 *
 * `v` の実バイト範囲（byteOffset/byteLength）のみを対象にするため、より大きな
 * バッファのスライスでも安全に扱える。
 */
export function encryptVector(key: Uint8Array, v: Float32Array, aadBytes?: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return encrypt(key, bytes, aadBytes);
}

/**
 * {@link encryptVector} の逆操作。BLOB を復号して Float32Array を返す。
 *
 * 復号結果（`decrypt` が返す Uint8Array）は 4 バイト境界に整列しているとは限らず、
 * 親バッファの途中を指すこともあるため、Float32Array へ載せ替える前に
 * 新しい整列済みバッファへコピーする。
 */
export function decryptVector(
  key: Uint8Array,
  blob: Uint8Array,
  aadBytes?: Uint8Array,
): Float32Array {
  const bytes = decrypt(key, blob, aadBytes);
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer, 0, aligned.byteLength / 4);
}

/**
 * 決定的なブラインドインデックス（タグの重複排除・検索用フィンガープリント）。
 *
 * 鍵付き BLAKE2b（`crypto_generichash` の keyed モード）で UTF-8 文字列を MAC し、
 * base64（ORIGINAL）文字列を返す。nonce を使わない決定的計算なので、
 * 同じ平文 → 同じフィンガープリントとなり、暗号化したまま等価判定・検索できる。
 *
 * トレードオフ: DB 閲覧者に対しタグ値の **等価性・出現頻度** は漏れる（同一タグは
 * 同一フィンガープリントになる）が、鍵を知らなければ平文は復元できない。
 * 検索可能な暗号化タグとしては許容できる妥協。
 */
export function fingerprint(key: Uint8Array, s: string): string {
  const mac = sodium.crypto_generichash(sodium.crypto_generichash_BYTES, enc.encode(s), key);
  return sodium.to_base64(mac, sodium.base64_variants.ORIGINAL);
}
