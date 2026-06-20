import { describe, expect, test } from "bun:test";
import { moodOf, scoreSentiment } from "./sentiment.ts";

describe("scoreSentiment", () => {
  test("ポジティブ・ネガティブ・中立を符号で判定する", () => {
    expect(scoreSentiment("今日は良い天気です。")).toBeGreaterThan(0);
    expect(scoreSentiment("最悪だ。つらい。")).toBeLessThan(0);
    expect(scoreSentiment("今日はコードを書いた。")).toBe(0);
  });

  test("空文字・空白のみは 0（中立）", () => {
    expect(scoreSentiment("")).toBe(0);
    expect(scoreSentiment("   ")).toBe(0);
  });
});

describe("moodOf", () => {
  test("閾値で 3 分類する", () => {
    expect(moodOf(0.5)).toBe("positive");
    expect(moodOf(-0.5)).toBe("negative");
    expect(moodOf(0)).toBe("neutral");
    expect(moodOf(0.05)).toBe("neutral");
  });
});
