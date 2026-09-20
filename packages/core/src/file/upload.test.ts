import { describe, expect, test } from "bun:test";
import {
  ciphertextPartSize,
  DEFAULT_PART_BYTES,
  MAX_PART_BYTES,
  MAX_UPLOAD_BYTES,
  partRanges,
  validateUploadSize,
} from "./upload.ts";

describe("validateUploadSize", () => {
  test("9 GiB ちょうどは通る", () => {
    expect(MAX_UPLOAD_BYTES).toBe(9 * 1024 ** 3);
    expect(validateUploadSize(MAX_UPLOAD_BYTES).isOk()).toBe(true);
  });

  test("9 GiB 超は拒否する", () => {
    expect(validateUploadSize(MAX_UPLOAD_BYTES + 1).isErr()).toBe(true);
  });

  test("0 バイトは拒否する", () => {
    expect(validateUploadSize(0).isErr()).toBe(true);
  });
});

describe("partRanges", () => {
  test("part 番号は 1 始まりで、最後の part だけ短い", () => {
    expect(partRanges(250, 100)).toEqual([
      { index: 1, start: 0, end: 100 },
      { index: 2, start: 100, end: 200 },
      { index: 3, start: 200, end: 250 },
    ]);
  });

  test("ちょうど割り切れるときは端数の part を作らない", () => {
    expect(partRanges(200, 100)).toEqual([
      { index: 1, start: 0, end: 100 },
      { index: 2, start: 100, end: 200 },
    ]);
  });
});

describe("ciphertextPartSize", () => {
  test("既定 part サイズは Workers のボディ上限内に収まる", () => {
    expect(ciphertextPartSize(DEFAULT_PART_BYTES)).toBeLessThanOrEqual(MAX_PART_BYTES);
  });

  test("暗号文の part 境界で分けると平文の part 数と一致する", () => {
    const partSize = 100;
    const plain = partRanges(250, partSize);
    const cipherTotal = plain.reduce((n, r) => n + (r.end - r.start) + 40, 0);
    expect(partRanges(cipherTotal, ciphertextPartSize(partSize)).length).toBe(plain.length);
  });
});
