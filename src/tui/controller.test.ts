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

  test("backspace は末尾 1 文字を削除し、空なら何もしない", () => {
    expect(applyKey("ka", key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: "k",
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

  test("その他の修飾キー・制御シーケンスは無視する", () => {
    expect(applyKey("a", key({ name: "up", sequence: "[A" }))).toEqual({
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
