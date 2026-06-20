import sodium from "libsodium-wrappers-sumo";

/**
 * libsodium（sumo ビルド）の初期化ヘルパー。
 *
 * libsodium-wrappers は wasm を非同期にロードするため、いずれの暗号関数も
 * 利用前に一度 `await sodium.ready` を完了させておく必要がある。
 * アプリ起動時に一度 {@link ready} を呼べばよい（多重呼び出しは安全で、
 * `sodium.ready` は解決済みの同一 Promise を返す）。
 *
 * sumo ビルドを使うのは、標準ビルドには Argon2id（`crypto_pwhash`）が
 * 含まれないため（Phase 6 のパスフレーズ KDF で必要）。
 *
 * このモジュール配下の同期関数は、呼び出し前に {@link ready} が完了している
 * ことを前提とする。
 */
export async function ready(): Promise<typeof sodium> {
  await sodium.ready;
  return sodium;
}

export { sodium };
