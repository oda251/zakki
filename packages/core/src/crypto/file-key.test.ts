import { beforeAll, describe, expect, test } from "bun:test";
import {
  decryptPart,
  encryptPart,
  FEK_BYTES,
  generateFek,
  PART_OVERHEAD_BYTES,
  rewrapFek,
  unwrapFek,
  wrapFek,
} from "./file-key.ts";
import { generateSalt } from "./kdf.ts";
import { ready } from "./sodium.ts";

beforeAll(async () => {
  await ready();
});

/** テストを速く保つための最小 KDF パラメータ（実装既定は INTERACTIVE） */
const params = { opsLimit: 1, memLimit: 8192 * 1024 };

describe("FEK 封筒", () => {
  test("同じパスワード・ソルトで wrap → unwrap が往復する", () => {
    const fek = generateFek();
    expect(fek.length).toBe(FEK_BYTES);
    const salt = generateSalt();
    const envelope = wrapFek(fek, "correct horse", salt, params);
    expect(unwrapFek(envelope, "correct horse", salt, params)).toEqual(fek);
  });

  test("パスワードが違うと unwrap に失敗する", () => {
    const fek = generateFek();
    const salt = generateSalt();
    const envelope = wrapFek(fek, "correct horse", salt, params);
    expect(() => unwrapFek(envelope, "wrong horse", salt, params)).toThrow();
  });

  test("パスワード変更は封筒を作り直すだけで FEK は変わらない（既存ファイル不変）", () => {
    const fek = generateFek();
    const oldSalt = generateSalt();
    const newSalt = generateSalt();
    const before = wrapFek(fek, "old", oldSalt, params);
    const after = rewrapFek(before, "old", oldSalt, params, "new", newSalt, params);
    expect(after).not.toEqual(before);
    expect(unwrapFek(after, "new", newSalt, params)).toEqual(fek);
  });
});

describe("part 単位の暗号化", () => {
  test("encrypt → decrypt が往復し、暗号文長は平文長 + オーバーヘッド", () => {
    const fek = generateFek();
    const plain = new Uint8Array([1, 2, 3, 4, 5]);
    const cipher = encryptPart(fek, 1, plain);
    expect(PART_OVERHEAD_BYTES).toBe(40);
    expect(cipher.length).toBe(plain.length + PART_OVERHEAD_BYTES);
    expect(decryptPart(fek, 1, cipher)).toEqual(plain);
  });

  test("part 番号が違うと復号に失敗する（入れ替え・欠落の検出）", () => {
    const fek = generateFek();
    const cipher = encryptPart(fek, 1, new Uint8Array([9]));
    expect(() => decryptPart(fek, 2, cipher)).toThrow();
  });

  test("別の FEK では復号できない", () => {
    const cipher = encryptPart(generateFek(), 1, new Uint8Array([9]));
    expect(() => decryptPart(generateFek(), 1, cipher)).toThrow();
  });
});
