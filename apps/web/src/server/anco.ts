/**
 * anco wasm 変換アセットの配信条件（issue #26 / #89 / #134）。
 *
 * ファイルは **brotli 済み**（`.br`）で配布し、`Content-Encoding: br` を付けて
 * ブラウザに透過解凍させる（over-the-wire で reactor ~13MB + 辞書 ~7MB。
 * 展開後は 53.6 MiB / 26.9 MiB あり、非圧縮では配れない）。
 *
 * この表と Cache-Control を bun アダプタ（index.ts）と Workers アダプタ（worker.ts）で
 * 共有する。**ヘッダが片方だけ欠けると壊れ方が分かりにくい**（Content-Encoding が
 * 無いと圧縮バイトがそのまま WebAssembly.compile へ渡り
 * "expected magic word 00 61 73 6d" になる。2026-08-23 に実配備で発生）。
 */

/** `/anco/<file>` として配る不変アセットと、その Content-Type */
export const ANCO_ASSET_TYPES: ReadonlyMap<string, string> = new Map([
  ["anco.reactor.wasm.br", "application/wasm"],
  ["dict.tar.br", "application/x-tar"],
]);

/**
 * ref マーカー（issue #89）。install-anco-wasm.sh が書く導入 ref で、クライアントは
 * この値でアセット URL（`?v=<ref>`）と Cache API 名を versioning する。
 * **これだけ no-cache**（本体は ref 込み URL で不変になるので immutable でよい）。
 */
export const ANCO_REF_FILE = "ref.txt";

/** 不変アセットのキャッシュ指定 */
export const ANCO_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** ref マーカーのキャッシュ指定 */
export const ANCO_REF_CACHE = "no-cache";

/** 不変アセットの応答ヘッダ一式（brotli 済みであることを含む） */
export function ancoAssetHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Encoding": "br",
    "Cache-Control": ANCO_IMMUTABLE_CACHE,
  };
}
