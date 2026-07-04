import { describe, expect, test } from "bun:test";
import { isBannerLine, isTimeLine, parseCandidates, stripAnsi } from "./protocol.ts";

const ESC = String.fromCharCode(0x1b);

describe("stripAnsi", () => {
  test("bold エスケープを除去する", () => {
    expect(stripAnsi(`${ESC}[1m0${ESC}[0m. 今日は晴れ`)).toBe("0. 今日は晴れ");
  });

  test("エスケープがなければそのまま", () => {
    expect(stripAnsi("今日は晴れ")).toBe("今日は晴れ");
  });
});

describe("parseCandidates", () => {
  test("session の 1 ブロックから候補を抽出する", () => {
    const lines = ["きょうははれ", "0. 今日は晴れ", "1. 今日は腫れ", "Time: 0.012"];
    expect(parseCandidates(lines).candidates).toEqual(["今日は晴れ", "今日は腫れ"]);
  });

  test("候補行がなければ空", () => {
    expect(parseCandidates(["composition is stopped"]).candidates).toEqual([]);
  });

  test("候補テキスト内の ). は誤検出しない", () => {
    const { candidates } = parseCandidates(["0. 値は 3. 14 です"]);
    expect(candidates[0]).toBe("値は 3. 14 です");
  });
});

describe("行種別判定", () => {
  test("Time 行", () => {
    expect(isTimeLine("Time: 0.0123")).toBe(true);
    expect(isTimeLine("0. Time: hoge")).toBe(false);
  });

  test("バナー行", () => {
    expect(
      isBannerLine(
        "== Type :q to end session, type :d to delete character, type :c to stop composition. For other commands, type :h ==",
      ),
    ).toBe(true);
    expect(isBannerLine("Current Left-Side Context: 今日は")).toBe(false);
  });
});
