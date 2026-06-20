import { sodium } from "@zakki/core/crypto/sodium.ts";
import {
  aad,
  decryptString,
  decryptVector,
  encryptString,
  encryptVector,
  fingerprint as fieldFingerprint,
} from "@zakki/core/crypto/fields.ts";
import type { Db } from "@zakki/data/db/client.ts";

/**
 * data 層の暗号コンテキスト（Phase 5b）。
 *
 * DEK を Phase 5a のフィールドヘルパー（`fields.ts`）へ束縛し、AAD ラベルを
 * 付けて呼び出す薄いラッパ。各データ関数は `(db, ...)` シグネチャを変えず、
 * 内部で {@link getCrypto} を引いて暗号 ON/OFF を分岐する。未登録（OFF）なら
 * 平文のまま扱い、既存テストと挙動が完全一致する。
 */
export interface CryptoContext {
  /** 文字列を暗号化して base64 文字列を返す。`label` は AAD（フィールド束縛） */
  encString(s: string, label: string): string;
  /** base64 文字列を復号して文字列を返す */
  decString(b64: string, label: string): string;
  /** Float32 ベクトルを暗号化して BLOB 用バイト列を返す */
  encVector(v: Float32Array, label: string): Uint8Array;
  /** BLOB を復号して Float32Array を返す */
  decVector(blob: Uint8Array, label: string): Float32Array;
  /** タグ等の決定的ブラインドインデックス（DEK 鍵付き BLAKE2b） */
  fingerprint(s: string): string;
  /** 変化検知用の決定的ハッシュ。DEK 派生サブ鍵付き BLAKE2b（鍵漏れなしで安定） */
  contentHash(s: string): string;
}

/**
 * DEK を束ねた {@link CryptoContext} を作る。
 *
 * `contentHash` は DEK そのものではなく DEK から導出したサブ鍵（kdf, ctx=
 * "zakcthsh", id=1）を鍵にする。これにより `fingerprint`（DEK 直鍵）と鍵空間を
 * 分離しつつ、平文を保存せずに content の変化を検知できる。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} 完了が前提。
 */
export function makeCryptoContext(dek: Uint8Array): CryptoContext {
  const hashKey = sodium.crypto_kdf_derive_from_key(
    sodium.crypto_generichash_KEYBYTES,
    1,
    "zakcthsh",
    dek,
  );
  const encoder = new TextEncoder();
  return {
    encString: (s, label) => encryptString(dek, s, aad(label)),
    decString: (b64, label) => decryptString(dek, b64, aad(label)),
    encVector: (v, label) => encryptVector(dek, v, aad(label)),
    decVector: (blob, label) => decryptVector(dek, blob, aad(label)),
    fingerprint: (s) => fieldFingerprint(dek, s),
    contentHash: (s) =>
      sodium.to_base64(
        sodium.crypto_generichash(sodium.crypto_generichash_BYTES, encoder.encode(s), hashKey),
        sodium.base64_variants.ORIGINAL,
      ),
  };
}

/**
 * Db ハンドル → CryptoContext の登録簿。
 *
 * データ関数のシグネチャを変えずに DEK を伝搬させるため、WeakMap で Db に
 * コンテキストを紐付ける。未登録なら暗号 OFF（平文）として扱う。
 */
const registry = new WeakMap<Db, CryptoContext>();

/** Db に暗号コンテキストを登録する（initCrypto から呼ぶ） */
export function attachCrypto(db: Db, ctx: CryptoContext): void {
  registry.set(db, ctx);
}

/** Db の暗号コンテキストを引く。未登録（暗号 OFF）なら undefined */
export function getCrypto(db: Db): CryptoContext | undefined {
  return registry.get(db);
}
