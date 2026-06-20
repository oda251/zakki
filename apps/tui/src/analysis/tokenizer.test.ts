import { describe, expect, test } from "bun:test";
import { extractNouns, readingText, toKatakana } from "./tokenizer.ts";

describe("extractNouns（lindera 統合）", () => {
  test("内容語の名詞を抽出する", () => {
    const nouns = extractNouns("今日は自動保存の仕組みを実装した。");
    expect(nouns).toContain("自動");
    expect(nouns).toContain("保存");
    expect(nouns).toContain("実装");
  });

  test("数・代名詞・1文字名詞は除外する", () => {
    const nouns = extractNouns("これは3つの点だ。");
    expect(nouns).not.toContain("3");
    expect(nouns).not.toContain("これ");
    expect(nouns).not.toContain("点");
  });

  test("空文字列は空配列", () => {
    expect(extractNouns("")).toEqual([]);
  });
});

describe("readingText", () => {
  test("漢字を読み（カタカナ）に開く", () => {
    expect(readingText("自動保存")).toBe("ジドウホゾン");
  });

  test("読みのない英単語は表層形のまま", () => {
    expect(readingText("Claudeと話した")).toContain("Claude");
  });
});

describe("toKatakana", () => {
  test("ひらがなをカタカナへ", () => {
    expect(toKatakana("じどうほぞん")).toBe("ジドウホゾン");
  });

  test("カタカナ・漢字・英字はそのまま", () => {
    expect(toKatakana("ザッキzakki雑記")).toBe("ザッキzakki雑記");
  });
});
