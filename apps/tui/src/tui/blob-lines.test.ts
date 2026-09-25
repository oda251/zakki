import { describe, expect, test } from "bun:test";
import type { Chunk, ZakkiFile } from "@zakki/data/db/schema.ts";
import { blobChunkLines, splitChunksByKind } from "./blob-lines.ts";

const chunk = (over: Partial<Chunk>): Chunk => ({
  id: 1,
  parentId: 100,
  position: 0,
  kind: "text",
  fileId: null,
  content: "",
  date: null,
  polarity: null,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

const file = (over: Partial<ZakkiFile>): ZakkiFile => ({
  id: 1,
  name: "写真",
  extension: "png",
  encryption: "none",
  retention: "permanent",
  objectKey: "accounts/acc/permanent/1",
  size: 10,
  partSize: 8,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  ...over,
});

describe("splitChunksByKind", () => {
  test("G3: blob チャンクは編集バッファ（text）から外れる", () => {
    const { text, blob } = splitChunksByKind([
      chunk({ id: 1, position: 0, content: "一。" }),
      chunk({ id: 2, position: 1_000_000, kind: "blob", fileId: 7, content: "" }),
      chunk({ id: 3, position: 1, content: "二。" }),
    ]);
    expect(text.map((c) => c.id)).toEqual([1, 3]);
    expect(blob.map((c) => c.id)).toEqual([2]);
  });
});

describe("blobChunkLines", () => {
  test("G1: 画像でもファイル名だけを表示する", () => {
    const lines = blobChunkLines(
      [chunk({ id: 2, kind: "blob", fileId: 7 })],
      new Map([[2, file({ id: 7 })]]),
    );
    expect(lines).toEqual([{ id: 2, text: "写真.png" }]);
  });

  test("G2: 暗号化ファイルは復号できないのでプレースホルダを出す", () => {
    const lines = blobChunkLines(
      [chunk({ id: 2, kind: "blob", fileId: 7 })],
      new Map([[2, file({ id: 7, name: "開けない暗号文", encryption: "password" })]]),
    );
    expect(lines).toEqual([{ id: 2, text: "暗号化ファイル.png" }]);
  });

  test("file 行が引けない blob チャンクは飛ばす（同期途中の孤児）", () => {
    expect(blobChunkLines([chunk({ id: 2, kind: "blob", fileId: 7 })], new Map())).toEqual([]);
  });
});
