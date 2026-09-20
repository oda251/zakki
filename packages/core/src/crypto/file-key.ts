import { AAD } from "@zakki/core/crypto/aad.ts";
import { decrypt, encrypt } from "@zakki/core/crypto/aead.ts";
import { DEK_BYTES } from "@zakki/core/crypto/dek.ts";
import { deriveKey } from "@zakki/core/crypto/kdf.ts";
import { sodium } from "@zakki/core/crypto/sodium.ts";

/**
 * ファイル暗号鍵（FEK）管理（issue #157）。
 *
 * チャンク E2E 暗号の DEK（{@link import("@zakki/core/crypto/dek.ts").generateDek}）とは
 * **独立** した鍵。ファイル添付機能を DEK から切り離すことで、DEK のローテーションが
 * 既存の添付ファイルに波及しない（逆も同様）。封筒方式・KDF・AEAD は dek.ts / kdf.ts と
 * 同じ流儀（XChaCha20-Poly1305 + Argon2id）に揃える。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} を完了させておくこと。
 */

/** FEK の鍵長（バイト）。DEK と同じ AEAD を使うため同一長（{@link DEK_BYTES}）。 */
export const FEK_BYTES = DEK_BYTES;

/** ランダムな {@link FEK_BYTES} バイトの FEK を生成する。 */
export function generateFek(): Uint8Array {
  return sodium.randombytes_buf(FEK_BYTES);
}

/** Argon2id の ops/mem パラメータ（{@link import("@zakki/core/crypto/kdf.ts").deriveKey} に渡す） */
export interface FekKdfParams {
  readonly opsLimit: number;
  readonly memLimit: number;
}

/**
 * FEK をパスワード由来の KEK で AEAD 暗号化し、封筒（`nonce || ciphertext`）を返す。
 *
 * @param fek 包む対象の FEK
 * @param password KEK 導出に使うパスワード
 * @param salt {@link import("@zakki/core/crypto/kdf.ts").generateSalt} で生成したソルト
 * @param params 省略時は {@link import("@zakki/core/crypto/kdf.ts").defaultKdfParams}（INTERACTIVE）
 */
export function wrapFek(
  fek: Uint8Array,
  password: string,
  salt: Uint8Array,
  params?: FekKdfParams,
): Uint8Array {
  const kek = deriveKek(password, salt, params);
  return encrypt(kek, fek);
}

/**
 * 封筒をパスワード由来の KEK で復号して FEK を取り出す。
 *
 * @throws パスワード違い・封筒の改竄時（AEAD 認証失敗）
 */
export function unwrapFek(
  envelope: Uint8Array,
  password: string,
  salt: Uint8Array,
  params?: FekKdfParams,
): Uint8Array {
  const kek = deriveKek(password, salt, params);
  return decrypt(kek, envelope);
}

/**
 * パスワード変更時に封筒だけを作り直す（unwrap → wrap の合成）。
 *
 * FEK 自体は再生成しない。FEK を変えると既存の暗号化済みファイル（part 単位の
 * 暗号文）がすべて読めなくなるため、パスワード変更は「同じ FEK を新しい KEK で
 * 包み直す」だけに留める。
 */
export function rewrapFek(
  envelope: Uint8Array,
  oldPassword: string,
  oldSalt: Uint8Array,
  oldParams: FekKdfParams | undefined,
  newPassword: string,
  newSalt: Uint8Array,
  newParams?: FekKdfParams,
): Uint8Array {
  const fek = unwrapFek(envelope, oldPassword, oldSalt, oldParams);
  return wrapFek(fek, newPassword, newSalt, newParams);
}

function deriveKek(password: string, salt: Uint8Array, params?: FekKdfParams): Uint8Array {
  return deriveKey(password, salt, params?.opsLimit, params?.memLimit);
}

/** XChaCha20-Poly1305 の nonce 長（`crypto_aead_xchacha20poly1305_ietf_NPUBBYTES`） */
const AEAD_NONCE_BYTES = 24;

/** Poly1305 タグ長（`crypto_aead_xchacha20poly1305_ietf_ABYTES`） */
const AEAD_TAG_BYTES = 16;

/**
 * part 単位の暗号化で平文に付く固定オーバーヘッド（バイト）。`nonce || ciphertext`
 * 形式なので nonce 24 バイトと Poly1305 タグ 16 バイトの分だけ暗号文が長くなる。
 * R2 multipart の part サイズ計算（upload.ts の {@link import("@zakki/core/file/upload.ts").ciphertextPartSize}）が
 * この値を参照する。
 */
export const PART_OVERHEAD_BYTES = AEAD_NONCE_BYTES + AEAD_TAG_BYTES;

/**
 * part 番号を AAD に束縛して暗号化する。part の入れ替え・欠落を復号時に検出できる。
 *
 * @param fek {@link generateFek} で生成した鍵
 * @param partNumber R2 multipart の part 番号（1 始まり）
 * @param plaintext 平文バイト列
 */
export function encryptPart(
  fek: Uint8Array,
  partNumber: number,
  plaintext: Uint8Array,
): Uint8Array {
  return encrypt(fek, plaintext, partAad(partNumber));
}

/** {@link encryptPart} の逆操作。part 番号が異なると AEAD 認証に失敗して例外を投げる。 */
export function decryptPart(
  fek: Uint8Array,
  partNumber: number,
  ciphertext: Uint8Array,
): Uint8Array {
  return decrypt(fek, ciphertext, partAad(partNumber));
}

const enc = new TextEncoder();

function partAad(partNumber: number): Uint8Array {
  return enc.encode(`${AAD.filePart}:${partNumber}`);
}
