import { describe, expect, test } from "bun:test";
import type { KeyLike } from "./controller.ts";
import { applyKey, deriveDisplay, snapshotFromRaw } from "./controller.ts";

function key(partial: Partial<KeyLike> & { name: string }): KeyLike {
  return { sequence: "", ctrl: false, meta: false, ...partial };
}

describe("applyKey", () => {
  test("印字可能文字を末尾に追記する", () => {
    expect(applyKey("ka", key({ name: "k", sequence: "k" }))).toEqual({
      type: "edit",
      raw: "kak",
    });
  });

  test("大文字（shift 入力）も追記する", () => {
    expect(applyKey("", key({ name: "c", sequence: "C" }))).toEqual({
      type: "edit",
      raw: "C",
    });
  });

  test("backspace は確定かなをかな単位で、打鍵途中ローマ字は 1 文字で削る", () => {
    // 確定かな か(=ka) はローマ字スパンごと削除
    expect(applyKey("ka", key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: "",
    });
    // 拗音 きゃ(=kya) も 1 単位
    expect(applyKey("kya", key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: "",
    });
    // 打鍵途中ローマ字（pending）は 1 文字だけ
    expect(applyKey("kak", key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: "ka",
    });
    expect(applyKey("", key({ name: "backspace" }))).toEqual({ type: "none" });
  });

  test("return / space を追記する", () => {
    expect(applyKey("a", key({ name: "return" }))).toEqual({
      type: "edit",
      raw: "a\n",
    });
    expect(applyKey("a", key({ name: "space", sequence: " " }))).toEqual({
      type: "edit",
      raw: "a ",
    });
  });

  test("Ctrl+C / Ctrl+D で終了する", () => {
    expect(applyKey("a", key({ name: "c", ctrl: true }))).toEqual({
      type: "exit",
    });
    expect(applyKey("a", key({ name: "d", ctrl: true }))).toEqual({
      type: "exit",
    });
  });

  test("上下キーで履歴を 1 チャンクずつめくり、Esc で折りたたみへ戻す", () => {
    expect(applyKey("a", key({ name: "up", sequence: "[A" }))).toEqual({ type: "reveal-older" });
    expect(applyKey("a", key({ name: "down", sequence: "[B" }))).toEqual({ type: "reveal-newer" });
    expect(applyKey("a", key({ name: "escape" }))).toEqual({ type: "collapse" });
  });

  test("その他の修飾キー・制御シーケンスは無視する", () => {
    expect(applyKey("a", key({ name: "f1", sequence: "OP" }))).toEqual({
      type: "none",
    });
    expect(applyKey("a", key({ name: "s", sequence: "s", meta: true }))).toEqual({ type: "none" });
  });
});

describe("deriveDisplay", () => {
  test("converted と pending を分離して返す", () => {
    expect(deriveDisplay("kyouhaClaude tohanashita.sorekarak")).toEqual({
      converted: "きょうはClaudeとはなした。それから",
      pending: "k",
    });
  });
});

describe("snapshotFromRaw", () => {
  test("自動保存時は pending を converted に混ぜない", () => {
    expect(snapshotFromRaw("2026-06-12", "hon")).toEqual({
      date: "2026-06-12",
      raw: "hon",
      converted: "ほ",
    });
  });

  test("終了時は flush して確定する", () => {
    expect(snapshotFromRaw("2026-06-12", "hon", { flush: true })).toEqual({
      date: "2026-06-12",
      raw: "hon",
      converted: "ほん",
    });
  });
});
