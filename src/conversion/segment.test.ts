import { describe, expect, test } from "bun:test";
import { segmentKana } from "./segment.ts";

describe("segmentKana", () => {
  test("句点で完結セグメントに分割する", () => {
    expect(segmentKana("はれ。さんぽした！つづく")).toEqual([
      { text: "はれ。", complete: true, separator: false },
      { text: "さんぽした！", complete: true, separator: false },
      { text: "つづく", complete: false, separator: false },
    ]);
  });

  test("改行は区切りセグメントとして保持し、直前を完結させる", () => {
    expect(segmentKana("ひとつめ\nふたつめ")).toEqual([
      { text: "ひとつめ", complete: true, separator: false },
      { text: "\n", complete: true, separator: true },
      { text: "ふたつめ", complete: false, separator: false },
    ]);
  });

  test("連結すると元のテキストに戻る（lossless）", () => {
    const input = "はれ。\n\nClaudeとはなした！かきかけ";
    expect(
      segmentKana(input)
        .map((s) => s.text)
        .join(""),
    ).toBe(input);
  });

  test("空文字列は空配列", () => {
    expect(segmentKana("")).toEqual([]);
  });
});
