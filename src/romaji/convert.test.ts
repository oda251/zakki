import { describe, expect, test } from "bun:test";
import { PASTE_CLOSE, PASTE_OPEN, wrapPaste } from "@/conversion/paste.ts";
import { convertRomaji, deleteLastUnit } from "./convert.ts";

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
    expect(converted("denwa")).toBe("でんわ");
  });

  test("nn は後続によらず常に ん（ん＋母音は二重 n で出す）", () => {
    expect(converted("onna")).toBe("おんあ");
    expect(converted("rennai")).toBe("れんあい");
    // ん の後に な行を続けるには n を重ねる
    expect(converted("onnna")).toBe("おんな");
  });

  test("nn は ん 1 つに畳む（宙ぶらりんな n を残さない）", () => {
    // 単体・末尾: ん のみ。pending を残さない
    expect(convertRomaji("nn")).toEqual({ converted: "ん", pending: "" });
    // nn + 子音: んん にならない
    expect(converted("nnka")).toBe("んか");
    expect(converted("nnda")).toBe("んだ");
    // nn + 母音: ん + 母音（な行にしない）
    expect(converted("nna")).toBe("んあ");
    // nnn + 母音: ん + な行
    expect(converted("nnna")).toBe("んな");
    // 末尾が nn の語
    expect(converted("konn")).toBe("こん");
    expect(converted("konni")).toBe("こんい");
  });

  test("n' は ん", () => {
    expect(converted("kin'en", true)).toBe("きんえん");
  });

  test("n + 非英数字は ん", () => {
    expect(converted("hon,pen.")).toBe("ほん、ぺん。");
  });
});

describe("区切り文字のマージ（連続したら最後の 1 つだけ採用）", () => {
  test("句点が連続したら 1 つに畳む", () => {
    expect(converted("a..")).toBe("あ。");
    expect(converted("a。。")).toBe("あ。");
    expect(converted("a.。")).toBe("あ。");
  });

  test("異なる区切りが連続したら最後の 1 つを採用", () => {
    expect(converted("a.!")).toBe("あ！");
    expect(converted("a!?")).toBe("あ？");
  });

  test("文をまたいでも各境界で正しく畳む（孤立した区切りを残さない）", () => {
    expect(converted("aiu..kaki.")).toBe("あいう。かき。");
  });

  test("数字内のピリオドは句点にしない（直前が非かな）", () => {
    expect(converted("3.14")).toBe("3.14");
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

describe("ペースト領域はそのまま通す", () => {
  test("マーカーで囲まれた領域は変換せず素通しする（内部の句点も保持）", () => {
    const input = `ka${wrapPaste("Cat。neko")}`;
    expect(convertRomaji(input).converted).toBe(`か${PASTE_OPEN}Cat。neko${PASTE_CLOSE}`);
  });
});

describe("deleteLastUnit（かな単位 backspace）", () => {
  test("確定かなはローマ字スパンごと削る", () => {
    expect(deleteLastUnit("ka")).toBe("");
    expect(deleteLastUnit("kaki")).toBe("ka");
    expect(deleteLastUnit("kya")).toBe(""); // 拗音も 1 単位
    expect(deleteLastUnit("kakkya")).toBe("kak"); // 直前は促音 っ が残る
  });

  test("打鍵途中ローマ字（pending）は 1 文字だけ削る", () => {
    expect(deleteLastUnit("kak")).toBe("ka");
    expect(deleteLastUnit("ky")).toBe("k");
  });

  test("全角句読点（写像済み）も 1 単位として削る", () => {
    expect(deleteLastUnit("soudesu.")).toBe("soudesu");
  });

  test("英単語は 1 文字ずつ削る", () => {
    expect(deleteLastUnit("Claude")).toBe("Claud");
  });

  test("ペースト塊は 1 単位としてまとめて削る", () => {
    expect(deleteLastUnit(`ka${wrapPaste("neko。inu")}`)).toBe("ka");
  });

  test("空文字列は空のまま", () => {
    expect(deleteLastUnit("")).toBe("");
  });
});
