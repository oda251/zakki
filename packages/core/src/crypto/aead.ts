import { sodium } from "@zakki/core/crypto/sodium.ts";

/**
 * XChaCha20-Poly1305 IETF AEAD による認証付き暗号化。
 *
 * 24 バイトのランダムな nonce を生成し、`nonce || ciphertext` を連結して返す。
 * 24 バイト nonce はランダム生成での衝突が現実的に無視できるため、カウンタ管理が不要。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} を完了させておくこと。
 *
 * @param key 32 バイト鍵（`crypto_aead_xchacha20poly1305_ietf_KEYBYTES`）
 * @param plaintext 平文バイト列
 * @param aad 付加認証データ。暗号文を文脈に束縛する（既定: 空）。復号時に一致が必要
 * @returns `nonce || ciphertext`
 */
export function encrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    aad ?? null,
    null,
    nonce,
    key,
  );
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  return blob;
}

/**
 * {@link encrypt} の逆操作。`nonce || ciphertext` を分解して復号する。
 *
 * 認証に失敗した場合（改竄・鍵違い・aad 不一致）は **例外を投げる**。
 * 上位レイヤ（data 層）はこれを Result でラップする。
 *
 * @param key 32 バイト鍵
 * @param blob `nonce || ciphertext`
 * @param aad 暗号化時と同一の付加認証データ（既定: 空）
 * @returns 復号した平文バイト列
 * @throws nonce 長に満たない、または認証に失敗した場合
 */
export function decrypt(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (blob.length < nonceLen) {
    throw new Error("AEAD blob too short: missing nonce");
  }
  const nonce = blob.subarray(0, nonceLen);
  const ciphertext = blob.subarray(nonceLen);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    aad ?? null,
    nonce,
    key,
  );
}
