import { describe, expect, test } from "bun:test";
import { wrapPaste } from "@/conversion/paste.ts";
import { firstSentenceRomajiLen, freezeLiveTail, liveTailStart, parseBlocks } from "./records.ts";

describe("parseBlocks", () => {
  test("先頭の凍結リテラル＋末尾のライブを順に分解する", () => {
    const raw = `${wrapPaste("雨。")}${wrapPaste("晴れ。")}kyou`;
    const blocks = parseBlocks(raw);
    expect(blocks.map((b) => [b.frozen, b.text])).toEqual([
      [true, "雨。"],
      [true, "晴れ。"],
      [false, "kyou"],
    ]);
  });

  test("リテラルなしは全体が 1 ライブブロック", () => {
    expect(parseBlocks("ame")).toEqual([{ start: 0, end: 3, frozen: false, text: "ame" }]);
  });

  test("空文字列は空配列", () => {
    expect(parseBlocks("")).toEqual([]);
  });
});

describe("liveTailStart", () => {
  test("最後のリテラル以降を指す", () => {
    const raw = `${wrapPaste("雨。")}ki`;
    expect(raw.slice(liveTailStart(raw))).toBe("ki");
  });

  test("リテラルなしは 0", () => {
    expect(liveTailStart("ame")).toBe(0);
  });
});

describe("firstSentenceRomajiLen", () => {
  test("句点までのローマ字長を返す", () => {
    // "ame." → "あめ。"、続く "kyou" は次の文
    expect(firstSentenceRomajiLen("ame.kyou")).toBe(4);
  });

  test("境界が無ければ null", () => {
    expect(firstSentenceRomajiLen("ame")).toBeNull();
  });
});

// 入力をそのまま「変換済みテキスト」とみなす単純な settled 変換
const settled = (s: string) => ({ text: s, settled: true });
const unsettled = (s: string) => ({ text: s, settled: false });

describe("freezeLiveTail", () => {
  test("末尾の1文を除いて完結文を凍結リテラルへ畳む", () => {
    const { raw, changed } = freezeLiveTail("a。b。c", settled);
    expect(changed).toBe(true);
    // "a。" "b。" が凍結、"c" がライブで残る
    expect(raw).toBe(`${wrapPaste("a。")}${wrapPaste("b。")}c`);
  });

  test("最後の1文（句点付き）はライブのまま残す", () => {
    const { raw, changed } = freezeLiveTail("a。", settled);
    expect(changed).toBe(false);
    expect(raw).toBe("a。");
  });

  test("未変換（settled でない）に達したら畳まず止める", () => {
    const { raw, changed } = freezeLiveTail("a。b", unsettled);
    expect(changed).toBe(false);
    expect(raw).toBe("a。b");
  });

  test("既存の凍結リテラルは保ち、ライブ末尾だけを畳む", () => {
    const raw = `${wrapPaste("雨。")}a。b`;
    const out = freezeLiveTail(raw, settled);
    expect(out.raw).toBe(`${wrapPaste("雨。")}${wrapPaste("a。")}b`);
  });

  test("改行境界は区切りとして捨て、本文を凍結する", () => {
    const { raw } = freezeLiveTail("a\nb", settled);
    expect(raw).toBe(`${wrapPaste("a")}b`);
  });
});
