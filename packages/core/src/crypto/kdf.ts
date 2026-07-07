import { DEK_BYTES } from "@zakki/core/crypto/dek.ts";
import { sodium } from "@zakki/core/crypto/sodium.ts";

/**
 * Argon2id によるパスフレーズ → 鍵導出（KDF）。
 *
 * パスフレーズから KEK（鍵暗号鍵）を導出する用途（Phase 6）。memory-hard な
 * Argon2id によりオフライン総当たりを遅延させる。
 *
 * 既定の ops/mem は INTERACTIVE プリセット（{@link defaultKdfParams} が SSOT, issue #56）。
 * Phase 6 で防御強度を上げる場合は MODERATE（`crypto_pwhash_OPSLIMIT_MODERATE` /
 * `MEMLIMIT_MODERATE`）へ引き上げる余地がある。引数で渡すパラメータは封筒メタデータ
 * として保存し、復号時に同一値で再導出できるようにすること。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} を完了させておくこと。
 */

/**
 * 既定の Argon2id パラメータ（INTERACTIVE プリセット）の SSOT（issue #56）。
 *
 * sodium の定数は wasm 初期化（`ready`）完了後に初めて値が入るため、モジュール
 * 評価時に捕捉すると undefined になる。呼び出し時に読むよう関数にしている。
 * 強度を MODERATE へ上げる際はここだけ変更する（保存済み封筒は封筒側の
 * kdf_ops/kdf_mem で復号されるため互換）。
 */
export function defaultKdfParams(): { opsLimit: number; memLimit: number } {
  return {
    opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  };
}

/**
 * パスフレーズと 16 バイトのソルトから KEK を導出する。
 *
 * @param passphrase ユーザのパスフレーズ
 * @param salt {@link generateSalt} で生成した 16 バイトのソルト
 * @param opsLimit 計算コスト（既定: INTERACTIVE, {@link defaultKdfParams}）
 * @param memLimit メモリコスト（バイト, 既定: INTERACTIVE, {@link defaultKdfParams}）
 * @returns {@link DEK_BYTES}（= 32）バイトの導出鍵（KEK は DEK と同じ AEAD 鍵長）
 */
export function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  opsLimit: number = defaultKdfParams().opsLimit,
  memLimit: number = defaultKdfParams().memLimit,
): Uint8Array {
  return sodium.crypto_pwhash(
    DEK_BYTES,
    passphrase,
    salt,
    opsLimit,
    memLimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/**
 * Argon2id 用のランダムなソルトを生成する（`crypto_pwhash_SALTBYTES` = 16 バイト）。
 * ソルトは秘密ではなく、封筒と一緒に保存して構わない。
 */
export function generateSalt(): Uint8Array {
  return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
}
