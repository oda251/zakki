import { describe, expect, test } from "bun:test";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import {
  editableBlockAt,
  firstSentenceRomajiLen,
  freezeLiveTail,
  liveTailStart,
  parseBlocks,
  replaceBlock,
} from "./records.ts";

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

  test("連続した区切り文字は末尾まで 1 文に含める（孤立した区切りを残さない）", () => {
    // "a.." は "あ。" に畳まれる。ローマ字長は両方の "." を含む 3
    expect(firstSentenceRomajiLen("a..")).toBe(3);
    // 次の文の手前で止まる
    expect(firstSentenceRomajiLen("a..kaki.")).toBe(3);
  });
});

describe("editableBlockAt", () => {
  test("凍結リテラルは prefix・position と 1:1 で対応する", () => {
    const raw = `${wrapPaste("雨。")}${wrapPaste("晴れ。")}`;
    const b0 = editableBlockAt(raw, 0);
    const b1 = editableBlockAt(raw, 1);
    expect(b0).toMatchObject({ frozen: true, text: "雨。" });
    expect(b1).toMatchObject({ frozen: true, text: "晴れ。" });
    // 領域 [start,end) が parseBlocks の凍結ブロックと一致する
    const frozen = parseBlocks(raw).filter((b) => b.frozen);
    expect([b0?.start, b0?.end]).toEqual([frozen[0]?.start, frozen[0]?.end]);
    expect([b1?.start, b1?.end]).toEqual([frozen[1]?.start, frozen[1]?.end]);
  });

  // 回帰: エントリ末尾の文はライブのローマ字（未凍結）として raw に残るため、
  // 凍結リテラルとしては解決できない。これを編集領域として解決できないと、
  // 詳細ペインの最後（＝単一チャンクの日では唯一）のチャンクが編集できなくなる。
  test("末尾のライブ文も編集領域として解決する（frozen:false）", () => {
    const raw = `${wrapPaste("あめです。")}haredesu.`;
    // position 1 はライブ末尾 "haredesu."（凍結数 1）。範囲は当該ローマ字を指す
    const live = editableBlockAt(raw, 1);
    expect(live).toMatchObject({ frozen: false });
    expect(raw.slice(live?.start, live?.end)).toBe("haredesu.");
    // 当該領域だけを置換すると、その文だけが凍結リテラルへ畳まれる
    const next = replaceBlock(raw, live?.start ?? 0, live?.end ?? 0, "はれです。");
    expect(next).toBe(`${wrapPaste("あめです。")}${wrapPaste("はれです。")}`);
  });

  test("ライブ末尾が複数文なら文ごとに領域を分ける", () => {
    const raw = `${wrapPaste("あめです。")}haredesu.kumori`;
    const s1 = editableBlockAt(raw, 1);
    const s2 = editableBlockAt(raw, 2);
    expect(raw.slice(s1?.start, s1?.end)).toBe("haredesu.");
    expect(raw.slice(s2?.start, s2?.end)).toBe("kumori");
    expect(editableBlockAt(raw, 3)).toBeNull();
  });

  test("範囲外は null", () => {
    expect(editableBlockAt(wrapPaste("雨。"), 1)).toBeNull();
    expect(editableBlockAt("", 0)).toBeNull();
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

  test("Enter（改行）で終えた文は最後でも確定する", () => {
    const { raw, changed } = freezeLiveTail("a\n", settled);
    expect(changed).toBe(true);
    expect(raw).toBe(wrapPaste("a"));
  });

  test("句点の直後で Enter（文。＋改行）も確定する", () => {
    // "a。" の後で Enter → 改行は rest 側に出るが、確定して凍結する
    const { raw, changed } = freezeLiveTail("a。\n", settled);
    expect(changed).toBe(true);
    expect(raw).toBe(wrapPaste("a。"));
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
