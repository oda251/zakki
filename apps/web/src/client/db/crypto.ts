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

/**
 * 何もしない {@link FieldCrypto}（暗号 OFF, issue #133）。
 *
 * 暗号は opt-in で、既定では封筒を持たない DB を使う（issue #129 の決定 2）。
 * その構成でも replication の経路は 1 本に保ちたいので、変換だけを恒等関数に
 * 差し替える。fingerprint が平文名そのものになるのは data 層の暗号 OFF 時と
 * 同じ規約（analysis/apply.ts の `crypto === undefined ? name : ...`）で、
 * TUI が書いた行と web が書いた行が同じキーで一意化される。
 *
 * これを使うのは「サーバから封筒 0 件が返った」ときだけ。取得に失敗した
 * （オフライン）ときは暗号の有無が分からないので replication を開始しない。
 */
export function plaintextFieldCrypto(): FieldCrypto {
  return {
    encString: (s) => s,
    decString: (s) => s,
    fingerprint: (s) => s,
  };
}
