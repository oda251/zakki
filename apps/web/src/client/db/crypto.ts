/**
 * クライアント側 RxDB レプリケーション用のフィールド暗号ヘルパー（Phase 2, #40）。
 *
 * data 層の `crypto-context.ts` と同じ考え方の薄いラッパーだが、こちらは
 * RxDB modifier からのみ使う想定のため文字列フィールドのみを扱う。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} 完了が前提
 * （本モジュールは呼ばない。呼び出し側の責務）。
 */
import { aad, decryptString, encryptString, fingerprint } from "@zakki/core/crypto/fields.ts";

export interface FieldCrypto {
  /** 文字列を暗号化して base64 文字列を返す。`label` は AAD（フィールド束縛） */
  encString(s: string, label: string): string;
  /** base64 文字列を復号して文字列を返す */
  decString(b64: string, label: string): string;
  /** タグ等の決定的ブラインドインデックス（DEK 鍵付き BLAKE2b） */
  fingerprint(s: string): string;
}

/** DEK を束ねた {@link FieldCrypto} を作る。 */
export function makeFieldCrypto(dek: Uint8Array): FieldCrypto {
  return {
    encString: (s, label) => encryptString(dek, s, aad(label)),
    decString: (b64, label) => decryptString(dek, b64, aad(label)),
    fingerprint: (s) => fingerprint(dek, s),
  };
}
