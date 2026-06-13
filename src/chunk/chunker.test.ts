import { describe, expect, test } from "bun:test";
import { wrapPaste } from "@/conversion/paste.ts";
import { chunkText, displayTail, makeTitle } from "./chunker.ts";

describe("chunkText", () => {
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

  test("句点（。！？）で分割し、句点は前の文に残す", () => {
    const drafts = chunkText("はれ。さんぽした！たのしかった？おわり");
    expect(drafts.map((d) => d.content)).toEqual([
      "はれ。",
      "さんぽした！",
      "たのしかった？",
      "おわり",
    ]);
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

  test("ペースト領域は内部の句点・改行で分割せず 1 つの atomic チャンクにする", () => {
    const input = `まえ。${wrapPaste("いち。に。\nさん")}あと`;
    const drafts = chunkText(input);
    expect(drafts).toEqual([
      { content: "まえ。" },
      { content: "いち。に。\nさん", atomic: true },
      { content: "あと" },
    ]);
  });
});

describe("displayTail", () => {
  test("末尾 count チャンク分だけ返す（折りたたみ表示）", () => {
    expect(displayTail("いち。に。さん。よん", 2)).toBe("さん。よん");
  });

  test("ペースト領域は 1 チャンクとして数え、マーカーは除去する", () => {
    const text = `いち。${wrapPaste("はりつけ。ぶん")}にゅうりょくちゅう`;
    expect(displayTail(text, 2)).toBe("はりつけ。ぶんにゅうりょくちゅう");
  });

  test("チャンク数が count 以下なら全文を返す", () => {
    expect(displayTail("いち。に", 5)).toBe("いち。に");
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
