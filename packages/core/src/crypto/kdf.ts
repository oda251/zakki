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

/** WebAuthn PRF 拡張の出力長（バイト）。仕様上 32 バイトのシークレットが得られる */
export const PRF_OUTPUT_BYTES = 32;

/**
 * {@link deriveKekFromPrf} の domain separation 用コンテキスト。BLAKE2b の鍵として
 * 使い、同じ PRF 出力を他用途（別アプリ・別バージョン）でハッシュした値と衝突しない
 * ようにする。**変更すると既存の passkey 封筒が開けなくなる**（変更時は v2 として
 * 別コンテキストを追加し、封筒側にバージョンを持たせること）。
 * BLAKE2b の鍵長制約（16..64 バイト）内の ASCII 固定文字列。
 */
const PRF_KEK_CONTEXT = "zakki-passkey-prf-kek-v1";

/**
 * WebAuthn PRF 拡張の出力（32 バイトの高エントロピーシークレット）から KEK を導出する
 * （issue #103, docs/RESEARCH.md §6 の passkey 封筒）。
 *
 * PRF 出力は認証器由来の一様ランダム値なので、パスフレーズと違い memory-hard KDF
 * （Argon2id）による総当たり遅延は不要。BLAKE2b（`crypto_generichash`）の keyed hash に
 * {@link PRF_KEK_CONTEXT} を鍵として与え、domain separation した 32 バイト KEK を返す。
 * 決定的（同じ PRF 出力 → 同じ KEK）なのでソルトは持たない。
 *
 * @param prfOutput WebAuthn PRF 評価結果（{@link PRF_OUTPUT_BYTES} = 32 バイト厳守）
 * @returns {@link DEK_BYTES}（= 32）バイトの KEK
 * @throws prfOutput が 32 バイトでない場合（PRF 未対応環境の切り詰め値等を拒否する）
 */
export function deriveKekFromPrf(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) {
    throw new Error(`PRF 出力は ${PRF_OUTPUT_BYTES} バイトのはず: got ${prfOutput.length}`);
  }
  return sodium.crypto_generichash(DEK_BYTES, prfOutput, sodium.from_string(PRF_KEK_CONTEXT));
}
