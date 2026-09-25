import { describe, expect, test } from "bun:test";
import type { FileDoc } from "@zakki/web/client/db/database.ts";
import {
  fileLabel,
  graphNodeLabel,
  isFileExpired,
  mimeTypeForFile,
  retentionLabel,
} from "@zakki/web/client/files/display.ts";
import type { GraphNode } from "@zakki/web/shared/api-types.ts";

const file: FileDoc = {
  id: "file-1",
  name: "写真",
  extension: "png",
  encryption: "none",
  retention: "7d",
  objectKey: "accounts/acc/7d/file-1",
  size: 100,
  partSize: 33_554_432,
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: 1,
  parentId: null,
  position: 0,
  content: "本文",
  kind: "text",
  fileId: null,
  date: "2026-07-01",
  polarity: null,
  tags: [],
  userTags: [],
  childCount: 0,
  descendantCount: 0,
  ...over,
});

describe("file display", () => {
  test("ファイル名と保存期限を構成する", () => {
    expect(fileLabel(file)).toBe("写真.png");
    expect(fileLabel({ ...file, extension: "" })).toBe("写真");
    expect(retentionLabel(file.retention)).toBe("7日");
    expect(retentionLabel("permanent")).toBe("無期限");
  });

  test("graph node は text なら本文、blob なら file 名を表示する", () => {
    const files = new Map([[file.id, file]]);
    expect(graphNodeLabel(node(), files)).toBe("本文");
    expect(graphNodeLabel(node({ kind: "blob", fileId: file.id, content: "" }), files)).toBe(
      "写真.png",
    );
    expect(graphNodeLabel(node({ kind: "blob", fileId: "missing", content: "" }), files)).toBe(
      "ファイル",
    );
  });

  test("有限 retention の経過後は期限切れ、permanent は永続", () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(isFileExpired(file, Date.parse(file.updatedAt) + sevenDays - 1)).toBe(false);
    expect(isFileExpired(file, Date.parse(file.updatedAt) + sevenDays)).toBe(true);
    expect(isFileExpired({ ...file, retention: "permanent" }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  test("拡張子から MIME を判定する", () => {
    expect(mimeTypeForFile(file)).toBe("image/png");
    expect(mimeTypeForFile({ ...file, extension: "pdf" })).toBe("application/pdf");
    expect(mimeTypeForFile({ ...file, extension: "bin" })).toBe("application/octet-stream");
  });
});
