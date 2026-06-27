import { describe, expect, test } from "bun:test";
import { EditBuffer, EditorView } from "@opentui/core";
import { globalDisplayCol, visualPosition } from "./width.ts";

/**
 * native-cursor.ts と同じ計測手順（word 折り返し + getLineInfo）で、
 * globalDisplayCol / visualPosition が opentui の実レイアウトと一致するセル位置を
 * 返すことを固定する。opentui のバージョン更新で lineStartCols の座標系
 * （改行=+1・折り返し=+0・全角=2セル）が変わったら、ここで検知する。
 */
function cell(width: number, text: string, offset: number): { row: number; cellCol: number } {
  const buffer = EditBuffer.create("wcwidth");
  const view = EditorView.create(buffer, Math.max(1, width), 4096);
  view.setWrapMode("word");
  buffer.setText(text);
  const g = globalDisplayCol(text, Math.max(0, Math.min(text.length, offset)));
  const result = visualPosition(view.getLineInfo().lineStartCols, g);
  view.destroy();
  buffer.destroy();
  return result;
}

describe("カーソルセル位置（opentui 実レイアウトとの整合）", () => {
  test("全角末尾入力で 2 セル進む（バグの核心）", () => {
    expect(cell(80, "あ", 1)).toEqual({ row: 0, cellCol: 2 });
    expect(cell(80, "あい", 2)).toEqual({ row: 0, cellCol: 4 });
  });
  test("半角と全角の混在", () => {
    expect(cell(80, "aあb", 1)).toEqual({ row: 0, cellCol: 1 });
    expect(cell(80, "aあb", 2)).toEqual({ row: 0, cellCol: 3 });
    expect(cell(80, "aあb", 3)).toEqual({ row: 0, cellCol: 4 });
  });
  test("全角の折り返し（幅 4 で 2 文字ごと）", () => {
    expect(cell(4, "あいうえ", 3)).toEqual({ row: 1, cellCol: 2 });
    expect(cell(4, "あいうえ", 4)).toEqual({ row: 1, cellCol: 4 });
  });
  test("改行をまたぐ全角", () => {
    expect(cell(80, "ab\nあい", 3)).toEqual({ row: 1, cellCol: 0 });
    expect(cell(80, "ab\nあい", 5)).toEqual({ row: 1, cellCol: 4 });
  });
  test("絵文字は 2 セル", () => {
    expect(cell(80, "🍣", 2)).toEqual({ row: 0, cellCol: 2 });
  });
});
