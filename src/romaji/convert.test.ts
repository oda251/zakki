import { describe, expect, test } from "bun:test";
import { convertRomaji } from "./convert.ts";

function converted(input: string, flush = false): string {
  return convertRomaji(input, { flush }).converted;
}

describe("基本変換", () => {
  test("五十音", () => {
    expect(converted("aiueo")).toBe("あいうえお");
    expect(converted("kakikukeko")).toBe("かきくけこ");
    expect(converted("sashisuseso")).toBe("さしすせそ");
  });

  test("ヘボン式と訓令式の両方を受理する", () => {
    expect(converted("shi")).toBe("し");
    expect(converted("si")).toBe("し");
    expect(converted("chi")).toBe("ち");
    expect(converted("ti")).toBe("ち");
    expect(converted("tsu")).toBe("つ");
    expect(converted("tu")).toBe("つ");
    expect(converted("fu")).toBe("ふ");
    expect(converted("hu")).toBe("ふ");
    expect(converted("ji")).toBe("じ");
    expect(converted("zi")).toBe("じ");
  });

  test("拗音", () => {
    expect(converted("kyakyukyo")).toBe("きゃきゅきょ");
    expect(converted("sha")).toBe("しゃ");
    expect(converted("sya")).toBe("しゃ");
    expect(converted("cho")).toBe("ちょ");
  });

  test("外来音・小書き", () => {
    expect(converted("fairu")).toBe("ふぁいる");
    expect(converted("thi")).toBe("てぃ");
    expect(converted("xtu")).toBe("っ");
    expect(converted("ltu")).toBe("っ");
  });
});

describe("促音・撥音", () => {
  test("子音の連続は っ", () => {
    expect(converted("kitte")).toBe("きって");
    expect(converted("zasshi")).toBe("ざっし");
    expect(converted("ippai")).toBe("いっぱい");
  });

  test("tch は っち", () => {
    expect(converted("matcha")).toBe("まっちゃ");
  });

  test("n + 子音は ん", () => {
    expect(converted("kanji")).toBe("かんじ");
    expect(converted("zenbu")).toBe("ぜんぶ");
    expect(converted("konnichiwa")).toBe("こんにちわ");
  });

  test("n + n は ん + な行（onna → おんな）", () => {
    expect(converted("onna")).toBe("おんな");
  });

  test("n' は ん", () => {
    expect(converted("kin'en", true)).toBe("きんえん");
  });

  test("n + 非英数字は ん", () => {
    expect(converted("hon,pen.")).toBe("ほん、ぺん。");
  });
});

describe("pending（打鍵途中の保留）", () => {
  test("末尾の孤立子音は pending", () => {
    expect(convertRomaji("k")).toEqual({ converted: "", pending: "k" });
    expect(convertRomaji("kak")).toEqual({ converted: "か", pending: "k" });
    expect(convertRomaji("ky")).toEqual({ converted: "", pending: "ky" });
  });

  test("末尾の n は pending（次打鍵で な行 か ん に分岐）", () => {
    expect(convertRomaji("hon")).toEqual({ converted: "ほ", pending: "n" });
  });

  test("flush で pending を確定する", () => {
    expect(convertRomaji("hon", { flush: true })).toEqual({
      converted: "ほん",
      pending: "",
    });
    expect(convertRomaji("honn", { flush: true })).toEqual({
      converted: "ほん",
      pending: "",
    });
  });
});

describe("英単語パススルー（大文字始まり）", () => {
  test("大文字で始まる単語はかな変換しない", () => {
    expect(converted("Claude")).toBe("Claude");
    expect(converted("GPT4")).toBe("GPT4");
  });

  test("直後のスペース 1 個は区切りとして消費する", () => {
    expect(converted("Claude gakaita")).toBe("Claudeがかいた");
  });

  test("スペース 2 個は 1 個に縮約する", () => {
    expect(converted("Claude  Code wotsukau")).toBe("Claude Codeをつかう");
  });

  test("記号で終端し、記号は消費しない", () => {
    expect(converted("OpenTUI.")).toBe("OpenTUI.");
    expect(converted("Bun\ndeugoku")).toBe("Bun\nでうごく");
  });

  test("日本語モード中のスペースは素通しする", () => {
    expect(converted("kyou ha hare")).toBe("きょう は はれ");
  });

  test("文中から英単語に切り替わる", () => {
    expect(converted("kyou ha Claude to hanashita")).toBe("きょう は Claudeと はなした");
  });

  test("小文字の英字列は保護されない（仕様）", () => {
    expect(converted("nya")).toBe("にゃ");
  });
});

describe("記号の写像", () => {
  test("かなの直後の句読点・ハイフンは全角化する", () => {
    expect(converted("soudesu.")).toBe("そうです。");
    expect(converted("e-to,")).toBe("えーと、");
  });

  test("かな以外の直後では写像しない", () => {
    expect(converted("3.14")).toBe("3.14");
    expect(converted("2026-06")).toBe("2026-06");
  });
});
