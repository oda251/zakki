import { describe, expect, test } from "bun:test";
import { displayWidth, globalDisplayCol, visualPosition } from "./width.ts";

describe("displayWidth", () => {
  test("空文字は 0", () => {
    expect(displayWidth("")).toBe(0);
  });
  test("ASCII は各 1 セル", () => {
    expect(displayWidth("abc")).toBe(3);
  });
  test("全角 1 文字は 2 セル", () => {
    expect(displayWidth("あ")).toBe(2);
  });
  test("全角 2 文字は 4 セル", () => {
    expect(displayWidth("あい")).toBe(4);
  });
  test("半角と全角の混在を合算する", () => {
    expect(displayWidth("aあb")).toBe(4);
  });
  test("絵文字は 2 セル", () => {
    expect(displayWidth("🍣")).toBe(2);
  });
  test("ZWJ 絵文字はコードポイント単位で合算する（opentui 互換）", () => {
    expect(displayWidth("👨‍👩‍👧")).toBe(6);
  });
  test("肌色修飾子も 2 セル", () => {
    expect(displayWidth("👍🏽")).toBe(4);
  });
  test("結合分音記号は 0 セル", () => {
    // "e" + U+0301（結合アキュート）
    expect(displayWidth("é")).toBe(1);
  });
});

describe("globalDisplayCol", () => {
  test("オフセット 0 は 0", () => {
    expect(globalDisplayCol("ab\nあい", 0)).toBe(0);
  });
  test("同一行内は表示幅の累積", () => {
    expect(globalDisplayCol("ab\nあい", 2)).toBe(2);
  });
  test("改行直後（改行は +1）", () => {
    expect(globalDisplayCol("ab\nあい", 3)).toBe(3);
  });
  test("改行をまたいだ累積（ab=2, \\n=1, あい=4）", () => {
    expect(globalDisplayCol("ab\nあい", 5)).toBe(7);
  });
  test("全角 1 文字手前から末尾", () => {
    expect(globalDisplayCol("あ", 1)).toBe(2);
  });
});

describe("visualPosition", () => {
  test("単一行・先頭", () => {
    expect(visualPosition([0], 0)).toEqual({ row: 0, cellCol: 0 });
  });
  test("折り返し 2 行目の途中", () => {
    expect(visualPosition([0, 4], 6)).toEqual({ row: 1, cellCol: 2 });
  });
  test("行頭ちょうど（境界は次行先頭）", () => {
    expect(visualPosition([0, 3, 8], 8)).toEqual({ row: 2, cellCol: 0 });
  });
  test("1 行目の途中", () => {
    expect(visualPosition([0, 4], 3)).toEqual({ row: 0, cellCol: 3 });
  });
});
