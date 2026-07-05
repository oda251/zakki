import { describe, expect, test } from "bun:test";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import { chunkText, makeTitle } from "./chunker.ts";

describe("chunkText（改行のみを区切りとする）", () => {
  test("改行で分割する", () => {
    expect(chunkText("きょうははれ\nさんぽした")).toEqual([
      { content: "きょうははれ" },
      { content: "さんぽした" },
    ]);
  });

  test("空行・空白のみの行は無視する", () => {
    const drafts = chunkText("ひとつめ\n\n   \nふたつめ\n");
    expect(drafts.map((d) => d.content)).toEqual(["ひとつめ", "ふたつめ"]);
  });

  test("句点（。！？）では分割しない（Enter だけが区切り）", () => {
    const drafts = chunkText("はれ。さんぽした！たのしかった？おわり");
    expect(drafts.map((d) => d.content)).toEqual(["はれ。さんぽした！たのしかった？おわり"]);
  });

  test("半角ピリオドでは分割しない", () => {
    const drafts = chunkText("OpenTUI 0.4.1 wo tameshita");
    expect(drafts).toHaveLength(1);
  });

  test("空文字列は空配列", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("同じ入力からは常に同じ結果（決定的）", () => {
    const input = "あさ。ひる。よる。\nまとめ";
    expect(chunkText(input)).toEqual(chunkText(input));
  });

  test("ペースト領域は内部の句点・改行を含んでも分割しない", () => {
    const input = `${wrapPaste("いち。に。\nさん")}`;
    expect(chunkText(input)).toEqual([{ content: "いち。に。\nさん" }]);
  });

  test("同一行のペースト領域と地の文は 1 チャンクへマージする", () => {
    const input = `まえ。${wrapPaste("いち。に。")}あと\nつぎ`;
    const drafts = chunkText(input);
    expect(drafts).toEqual([{ content: "まえ。いち。に。あと" }, { content: "つぎ" }]);
  });

  test("凍結リテラル（行単位）が改行で並ぶときは行ごとのチャンクになる", () => {
    const input = `${wrapPaste("きょうははれ。")}\n${wrapPaste("さんぽした")}\nkumori`;
    const drafts = chunkText(input);
    expect(drafts.map((d) => d.content)).toEqual(["きょうははれ。", "さんぽした", "kumori"]);
  });
});

describe("makeTitle", () => {
  test("先頭文をタイトルにする", () => {
    expect(makeTitle("はれ。さんぽした。")).toBe("はれ。");
  });

  test("40 文字を超える場合は切り詰めて … を付ける", () => {
    const long = "あ".repeat(50);
    const title = makeTitle(long);
    expect(title).toBe(`${"あ".repeat(40)}…`);
  });
});
