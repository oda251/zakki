import { eastAsianWidth } from "get-east-asian-width";

/**
 * 表示セル幅 0 のコードポイント範囲（包含）。結合文字・異体字セレクタ・
 * ゼロ幅書式制御をまとめる。各範囲は opentui のコードポイント単位 wcwidth が
 * 0 を返すことを実測で確認済み（U+FE10–FE19 の縦書き約物は幅 2 なので除外）。
 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // 結合分音記号
  [0x1ab0, 0x1aff], // 結合分音記号拡張
  [0x1dc0, 0x1dff], // 結合分音記号補助
  [0x200b, 0x200f], // ZWSP/ZWNJ/ZWJ/LRM/RLM
  [0x20d0, 0x20ff], // 記号用の結合文字
  [0xfe00, 0xfe0f], // 異体字セレクタ VS1–VS16
  [0xfe20, 0xfe2f], // 半マーク結合文字
  [0xfeff, 0xfeff], // ZWNBSP（BOM）
];

/**
 * コードポイント単位の表示セル幅。ゼロ幅範囲は 0、それ以外は
 * eastAsianWidth(cp)（wide/fullwidth→2, その他→1）。opentui のコードポイント単位
 * wcwidth に一致させる（ZWJ 絵文字は結合せず構成コードポイントを合算）。
 */
function charWidth(cp: number): number {
  for (const [lo, hi] of ZERO_WIDTH_RANGES) {
    if (cp >= lo && cp <= hi) {
      return 0;
    }
  }
  return eastAsianWidth(cp);
}

/**
 * 文字列の表示セル幅。コードポイント単位で走査し charWidth を合算する。
 * opentui のコードポイント単位 wcwidth と一致させる（ZWJ 絵文字は結合せず合算）。
 */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    width += charWidth(cp);
  }
  return width;
}

/**
 * カーソル手前のグローバル表示列。text.slice(0, offset) を走査し、
 * 改行 '\n' は +1、他の文字は charWidth を加算して返す。
 * opentui の lineStartCols と同じ座標系（改行=+1、折り返し=+0）。
 */
export function globalDisplayCol(text: string, offset: number): number {
  const slice = text.slice(0, offset);
  let col = 0;
  for (const ch of slice) {
    if (ch === "\n") {
      col += 1;
    } else {
      const cp = ch.codePointAt(0) ?? 0;
      col += charWidth(cp);
    }
  }
  return col;
}

/**
 * 折り返し行の開始表示列の配列 lineStartCols と
 * グローバル表示列 g から、視覚行 row と行内セル列 cellCol を逆算する。
 * row = lineStartCols[i] <= g を満たす最大の i（境界は次行先頭に倒す）。
 * cellCol = g - lineStartCols[row]。
 * lineStartCols が空なら [0] とみなす。
 */
export function visualPosition(
  lineStartCols: number[],
  g: number,
): { row: number; cellCol: number } {
  const cols: number[] = lineStartCols.length === 0 ? [0] : lineStartCols;
  let row = 0;
  for (let i = 1; i < cols.length; i++) {
    const start = cols[i] ?? 0;
    if (start <= g) {
      row = i;
    } else {
      break;
    }
  }
  return { row, cellCol: g - (cols[row] ?? 0) };
}
