/**
 * ファイル名の分解・表示ラベル生成（issue #157）。
 *
 * ファイル名自体は FEK で暗号化して保存する（{@link import("@zakki/core/crypto/aad.ts").AAD.fileName}）ため、
 * FEK を持たない TUI（復号能力がない）でもチャンクへの埋め込みラベルだけは
 * 作れるよう、復号できなかった場合のプレースホルダを用意する。
 */

/** ファイル名を復号できないときに表示に使うプレースホルダ（拡張子は暗号化対象外なので判別できる）。 */
export const ENCRYPTED_FILE_PLACEHOLDER_NAME = "暗号化ファイル";

/** 画像として扱う拡張子（小文字・ドット無し）の集合。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "ico",
]);

/** 拡張子が画像として扱う種類かどうか。大文字小文字を無視する。 */
export function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export interface SplitFilename {
  readonly name: string;
  readonly extension: string;
}

/**
 * ファイル名を「最後のドット」で本体と拡張子に分ける。拡張子は小文字化する。
 *
 * 先頭ドットのみ（`.gitignore` 等）はドットが 1 つでも拡張子とはみなさない
 * （dotfile の慣習に合わせる）。
 */
export function splitFilename(filename: string): SplitFilename {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    return { name: filename, extension: "" };
  }
  return {
    name: filename.slice(0, lastDot),
    extension: filename.slice(lastDot + 1).toLowerCase(),
  };
}

/** チャンク本文への埋め込み表示用ラベル。`name` が null（復号不能）ならプレースホルダを使う。 */
export function blobChunkLabel({
  name,
  extension,
}: {
  name: string | null;
  extension: string;
}): string {
  const base = name ?? ENCRYPTED_FILE_PLACEHOLDER_NAME;
  return extension ? `${base}.${extension}` : base;
}
