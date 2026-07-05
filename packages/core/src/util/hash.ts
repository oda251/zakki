/**
 * 依存ゼロの決定的ハッシュ（FNV-1a 64bit）。
 * 暗号用途ではなく、content の変化検知（embedding キャッシュ等）に使う。
 * Bun.hash の置き換え: ランタイム非依存（CF Workers / ブラウザ / Bun）で同値になる。
 */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export function contentHash64(input: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}
