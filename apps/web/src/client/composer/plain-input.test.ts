import { describe, expect, test } from "bun:test";
import { chunkText } from "@zakki/core/chunk/chunker.ts";
import { PASTE_CLOSE, PASTE_OPEN, wrapPaste } from "@zakki/core/conversion/paste.ts";
import { splitDisplay } from "@zakki/core/entry/records.ts";
import { freezePlainTail } from "./plain-input.ts";

const lit = (text: string) => PASTE_OPEN + text + PASTE_CLOSE;

describe("freezePlainTail（改行で完結した行を凍結リテラルへ畳む）", () => {
  test("改行で完結した行をリテラルにし、行区切りの改行は外に残す", () => {
    expect(freezePlainTail("abc\n")).toEqual({ raw: `${lit("abc")}\n`, changed: true });
  });

  test("改行が無い入力中の行は畳まない", () => {
    expect(freezePlainTail("abc")).toEqual({ raw: "abc", changed: false });
  });

  test("複数行はそれぞれ別のリテラルへ、末尾の未完行はライブのまま残る", () => {
    expect(freezePlainTail("a\nb\nc")).toEqual({
      raw: `${lit("a")}\n${lit("b")}\nc`,
      changed: true,
    });
  });

  test("空行は温存する（リテラルにしない）", () => {
    expect(freezePlainTail("a\n\n\nb\n")).toEqual({
      raw: `${lit("a")}\n\n\n${lit("b")}\n`,
      changed: true,
    });
  });

  test("既存リテラルより後ろだけが対象（二重に包まない）", () => {
    const raw = `${lit("確定")}\nab\n`;
    expect(freezePlainTail(raw)).toEqual({ raw: `${lit("確定")}\n${lit("ab")}\n`, changed: true });
  });

  test("凍結後の raw は表示チャンク列と chunkText が 1:1 に対応する", () => {
    const { raw } = freezePlainTail(`${lit("一つ目")}\nfutatsume\n三つ目`);
    expect(splitDisplay(raw).frozen.map((g) => g.content)).toEqual(["一つ目", "futatsume"]);
    expect(splitDisplay(raw).liveRaw).toBe("三つ目");
    expect(chunkText(raw).map((c) => c.content)).toEqual(["一つ目", "futatsume", "三つ目"]);
  });

  test("IME 確定で並んだ同一行のリテラルは 1 チャンクにまとまる", () => {
    const raw = `${wrapPaste("これは")}${wrapPaste("一文です")}\n`;
    expect(chunkText(freezePlainTail(raw).raw).map((c) => c.content)).toEqual(["これは一文です"]);
  });
});