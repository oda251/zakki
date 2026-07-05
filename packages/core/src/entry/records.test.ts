import { describe, expect, test } from "bun:test";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import {
  editableBlockAt,
  firstLineRomajiLen,
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

  test("リテラル直後の行区切り（改行）は確定済み領域として飛ばす", () => {
    const raw = `${wrapPaste("雨。")}\nki`;
    expect(raw.slice(liveTailStart(raw))).toBe("ki");
  });

  test("リテラルなしは 0", () => {
    expect(liveTailStart("ame")).toBe(0);
  });
});

describe("firstLineRomajiLen", () => {
  test("改行までのローマ字長を返す", () => {
    expect(firstLineRomajiLen("ame\nkyou")).toBe(4);
  });

  test("句点は境界にしない（Enter だけが区切り）", () => {
    expect(firstLineRomajiLen("ame.kyou")).toBeNull();
  });

  test("境界が無ければ null", () => {
    expect(firstLineRomajiLen("ame")).toBeNull();
  });

  test("連続した改行（空行）は末尾まで 1 行分に含める", () => {
    expect(firstLineRomajiLen("a\n\n")).toBe(3);
    expect(firstLineRomajiLen("a\n\nkaki\n")).toBe(3);
  });
});

describe("editableBlockAt", () => {
  test("行単位の凍結リテラルは position と 1:1 で対応する", () => {
    const raw = `${wrapPaste("雨。")}\n${wrapPaste("晴れ。")}`;
    const b0 = editableBlockAt(raw, 0);
    const b1 = editableBlockAt(raw, 1);
    expect(b0).toMatchObject({ frozen: true, text: "雨。" });
    expect(b1).toMatchObject({ frozen: true, text: "晴れ。" });
    expect(raw.slice(b0?.start, b0?.end)).toBe(wrapPaste("雨。"));
    expect(raw.slice(b1?.start, b1?.end)).toBe(wrapPaste("晴れ。"));
  });

  // 回帰: エントリ末尾の行はライブのローマ字（未凍結）として raw に残るため、
  // 凍結リテラルとしては解決できない。これを編集領域として解決できないと、
  // 詳細ペインの最後（＝単一チャンクの日では唯一）のチャンクが編集できなくなる。
  test("末尾のライブ行も編集領域として解決する（frozen:false）", () => {
    const raw = `${wrapPaste("あめです。")}\nharedesu.`;
    // position 1 はライブ末尾 "haredesu."（凍結行 1）。範囲は当該ローマ字を指す
    const live = editableBlockAt(raw, 1);
    expect(live).toMatchObject({ frozen: false });
    expect(raw.slice(live?.start, live?.end)).toBe("haredesu.");
    // 当該領域だけを置換すると、その行だけが凍結リテラルへ畳まれる
    const next = replaceBlock(raw, live?.start ?? 0, live?.end ?? 0, "はれです。");
    expect(next).toBe(`${wrapPaste("あめです。")}\n${wrapPaste("はれです。")}`);
  });

  test("ライブ末尾が複数行なら行ごとに領域を分ける", () => {
    const raw = `${wrapPaste("あめです。")}\nharedesu.\nkumori`;
    const s1 = editableBlockAt(raw, 1);
    const s2 = editableBlockAt(raw, 2);
    expect(raw.slice(s1?.start, s1?.end)).toBe("haredesu.");
    expect(raw.slice(s2?.start, s2?.end)).toBe("kumori");
    expect(editableBlockAt(raw, 3)).toBeNull();
  });

  test("同一行にリテラルとローマ字が混在する行は live 扱いで行全体を範囲にする", () => {
    const raw = `${wrapPaste("雨。")}tsuduki\nkumori`;
    const b0 = editableBlockAt(raw, 0);
    expect(b0).toMatchObject({ frozen: false });
    expect(raw.slice(b0?.start, b0?.end)).toBe(`${wrapPaste("雨。")}tsuduki`);
  });

  test("空行はチャンクにならないため position に数えない", () => {
    const raw = `${wrapPaste("雨。")}\n\n\nkumori`;
    expect(raw.slice(editableBlockAt(raw, 1)?.start, editableBlockAt(raw, 1)?.end)).toBe("kumori");
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
  test("Enter（改行）で完結した行を凍結リテラルへ畳み、行区切りは外に残す", () => {
    const { raw, changed } = freezeLiveTail("a\nb\nc", settled);
    expect(changed).toBe(true);
    expect(raw).toBe(`${wrapPaste("a")}\n${wrapPaste("b")}\nc`);
  });

  test("句点では畳まない（Enter だけが投稿の区切り）", () => {
    const { raw, changed } = freezeLiveTail("a。b。c", settled);
    expect(changed).toBe(false);
    expect(raw).toBe("a。b。c");
  });

  test("末尾の入力中行（改行なし）はライブのまま残す", () => {
    const { raw, changed } = freezeLiveTail("a。", settled);
    expect(changed).toBe(false);
    expect(raw).toBe("a。");
  });

  test("Enter で終えた行は最後でも確定する", () => {
    const { raw, changed } = freezeLiveTail("a\n", settled);
    expect(changed).toBe(true);
    expect(raw).toBe(`${wrapPaste("a")}\n`);
  });

  test("句点の直後で Enter（文。＋改行）も確定する", () => {
    const { raw, changed } = freezeLiveTail("a。\n", settled);
    expect(changed).toBe(true);
    expect(raw).toBe(`${wrapPaste("a。")}\n`);
  });

  test("複数文を含む行は 1 リテラル（1 チャンク）に畳む", () => {
    const { raw } = freezeLiveTail("a。b。c。\nd", settled);
    expect(raw).toBe(`${wrapPaste("a。b。c。")}\nd`);
  });

  test("未変換（settled でない）に達したら畳まず止める", () => {
    const { raw, changed } = freezeLiveTail("a\nb", unsettled);
    expect(changed).toBe(false);
    expect(raw).toBe("a\nb");
  });

  test("既存の凍結リテラルは保ち、ライブ末尾だけを畳む", () => {
    const raw = `${wrapPaste("雨。")}\na\nb`;
    const out = freezeLiveTail(raw, settled);
    expect(out.raw).toBe(`${wrapPaste("雨。")}\n${wrapPaste("a")}\nb`);
  });

  test("空行（連続改行）はリテラルを作らずそのまま温存する", () => {
    const { raw } = freezeLiveTail("a\n\n\nb", settled);
    expect(raw).toBe(`${wrapPaste("a")}\n\n\nb`);
  });

  test("凍結対象が無ければ changed=false（毎サイクルの空更新を出さない）", () => {
    const frozen = `${wrapPaste("a")}\n`;
    const out = freezeLiveTail(frozen, settled);
    expect(out.changed).toBe(false);
    expect(out.raw).toBe(frozen);
  });
});
