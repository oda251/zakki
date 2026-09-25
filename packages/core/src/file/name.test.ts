import { describe, expect, test } from "bun:test";
import {
  blobChunkLabel,
  ENCRYPTED_FILE_PLACEHOLDER_NAME,
  isImageExtension,
  splitFilename,
} from "./name.ts";

describe("isImageExtension", () => {
  test("画像拡張子は image と判定する", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"]) {
      expect(isImageExtension(ext)).toBe(true);
    }
  });

  test("画像でない拡張子・拡張子なしは false", () => {
    expect(isImageExtension("pdf")).toBe(false);
    expect(isImageExtension("txt")).toBe(false);
    expect(isImageExtension("")).toBe(false);
  });

  test("大文字小文字を無視する", () => {
    expect(isImageExtension("PNG")).toBe(true);
    expect(isImageExtension("JpEg")).toBe(true);
  });
});

describe("splitFilename", () => {
  test("最後のドットで分け、拡張子は小文字化する", () => {
    expect(splitFilename("a.b.PNG")).toEqual({ name: "a.b", extension: "png" });
  });

  test("拡張子が無ければ extension は空文字", () => {
    expect(splitFilename("README")).toEqual({ name: "README", extension: "" });
  });

  test("先頭ドットのみのファイル名は拡張子として扱わない", () => {
    expect(splitFilename(".gitignore")).toEqual({ name: ".gitignore", extension: "" });
  });
});

describe("blobChunkLabel", () => {
  test("name と extension を連結する", () => {
    expect(blobChunkLabel({ name: "写真", extension: "png" })).toBe("写真.png");
  });

  test("拡張子が空なら name のみ", () => {
    expect(blobChunkLabel({ name: "README", extension: "" })).toBe("README");
  });

  test("復号できない（name が null）ならプレースホルダを使う", () => {
    expect(blobChunkLabel({ name: null, extension: "png" })).toBe(
      `${ENCRYPTED_FILE_PLACEHOLDER_NAME}.png`,
    );
  });
});
