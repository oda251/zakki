/**
 * 封筒の wire 表現に必要な、**sodium を使わない**ヘルパ（issue #134）。
 *
 * 中継サーバは封筒を右から左へ渡すだけで、暗号処理は一切しない。にもかかわらず
 * base64 変換のために libsodium を読み込んでいたところ、**Cloudflare Workers で
 * `ready()` が解決せずリクエストがハングした**（例外ではなく無応答。
 * "Worker's code had hung and would never generate a response"）。bun では動くので
 * テストでは再現せず、実配備で初めて出た。
 *
 * サーバに要るのは「バイト列 ⇄ base64」と封筒の長さだけなので、ここに切り出して
 * sodium への依存そのものを断つ。結果として「サーバは復号能力を持たない」という
 * 不変条件（depcruise `web-server-no-decrypt-capability`）にも素直に沿う。
 */

/** base64（標準アルファベット・パディングあり）。`sodium.base64_variants.ORIGINAL` と同じ形 */
const BASE64_ORIGINAL = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * バイト列を base64（ORIGINAL）へ。
 *
 * 封筒は 72 バイト（{@link WRAPPED_DEK_BYTES}）程度を想定した実装で、
 * 大きな入力向けの分割処理はしていない。
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * base64（ORIGINAL）をバイト列へ。形が違えば投げる（sodium の `from_base64` と同じ扱い）。
 *
 * `atob` は実装によって空白やパディング崩れを黙って受けるので、先に形を検査する。
 * 受け取った封筒をそのまま保存する経路なので、緩く受けると開けない封筒が DB に入る。
 */
export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !BASE64_ORIGINAL.test(text)) {
    throw new Error("base64（ORIGINAL）の形ではありません");
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** XChaCha20-Poly1305 の nonce 長（`crypto_aead_xchacha20poly1305_ietf_NPUBBYTES`） */
const AEAD_NONCE_BYTES = 24;

/** Poly1305 タグ長（`crypto_aead_xchacha20poly1305_ietf_ABYTES`） */
const AEAD_TAG_BYTES = 16;

/** DEK の長さ（`DEK_BYTES`。dek.ts と同じ値） */
const DEK_BYTES = 32;

/**
 * wrap 済み DEK 封筒のバイト数。`nonce || ciphertext` なので長さが一意に決まり、
 * 「開けない封筒を保存させない」検査に使える（`apps/web/src/server/routes/crypto.ts`）。
 *
 * 数値は sodium の定数と一致していなければならない。ずれると正しい封筒を弾く／
 * 壊れた封筒を通すことになるので、wire.test.ts が sodium の実値と突き合わせる。
 */
export const WRAPPED_DEK_BYTES = AEAD_NONCE_BYTES + DEK_BYTES + AEAD_TAG_BYTES;
