import { sodium } from "@zakki/core/crypto/sodium.ts";

/**
 * Argon2id によるパスフレーズ → 鍵導出（KDF）。
 *
 * パスフレーズから KEK（鍵暗号鍵）を導出する用途（Phase 6）。memory-hard な
 * Argon2id によりオフライン総当たりを遅延させる。
 *
 * 既定の ops/mem は INTERACTIVE プリセット。Phase 6 で防御強度を上げる場合は
 * MODERATE（`crypto_pwhash_OPSLIMIT_MODERATE` / `MEMLIMIT_MODERATE`）へ引き上げる
 * 余地がある。引数で渡すパラメータは封筒メタデータとして保存し、復号時に
 * 同一値で再導出できるようにすること。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} を完了させておくこと。
 *
 * @param passphrase ユーザのパスフレーズ
 * @param salt {@link generateSalt} で生成した 16 バイトのソルト
 * @param opsLimit 計算コスト（既定: INTERACTIVE）
 * @param memLimit メモリコスト（バイト, 既定: INTERACTIVE）
 * @returns 32 バイトの導出鍵
 */
export function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  opsLimit: number = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
  memLimit: number = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
): Uint8Array {
  return sodium.crypto_pwhash(
    32,
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
