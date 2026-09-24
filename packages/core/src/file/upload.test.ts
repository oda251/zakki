import { describe, expect, test } from "bun:test";
import {
  ciphertextPartSize,
  DEFAULT_PART_BYTES,
  FILE_RETENTIONS,
  MAX_PART_BYTES,
  MAX_UPLOAD_BYTES,
  partRanges,
  PERMANENT_MAX_BYTES,
  validateUpload,
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

  test("整数でないサイズは拒否する", () => {
    expect(validateUploadSize(1.5).isErr()).toBe(true);
    expect(validateUploadSize(Number.NaN).isErr()).toBe(true);
  });
});

describe("validateUpload", () => {
  test("保存期限は permanent・1日・7日・30日だけ", () => {
    expect(FILE_RETENTIONS).toEqual(["permanent", "1d", "7d", "30d"]);
  });

  test("10 MiB 未満は permanent を許す", () => {
    expect(PERMANENT_MAX_BYTES).toBe(10 * 1024 ** 2);
    expect(validateUpload(PERMANENT_MAX_BYTES - 1, "permanent").isOk()).toBe(true);
  });

  test("10 MiB ちょうどは permanent を拒否する", () => {
    expect(validateUpload(PERMANENT_MAX_BYTES, "permanent").isErr()).toBe(true);
  });

  test("10 MiB ちょうどは各有限保存期限を許す", () => {
    for (const retention of ["1d", "7d", "30d"] as const) {
      expect(validateUpload(PERMANENT_MAX_BYTES, retention).isOk()).toBe(true);
    }
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
