import { describe, expect, test } from "bun:test";
import type { CursorState, KeyLike } from "./controller.ts";
import { applyEditKey, applyKey } from "./controller.ts";

function key(partial: Partial<KeyLike> & { name: string }): KeyLike {
  return { sequence: "", ctrl: false, meta: false, ...partial };
}

const st = (text: string, cursor: number): CursorState => ({ text, cursor });

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

describe("applyEditKey", () => {
  test("左右キーでカーソルを移動し、両端でクランプする", () => {
    expect(applyEditKey(st("あいう", 1), key({ name: "left" }))).toEqual(st("あいう", 0));
    expect(applyEditKey(st("あいう", 0), key({ name: "left" }))).toEqual(st("あいう", 0));
    expect(applyEditKey(st("あいう", 2), key({ name: "right" }))).toEqual(st("あいう", 3));
    expect(applyEditKey(st("あいう", 3), key({ name: "right" }))).toEqual(st("あいう", 3));
  });

  test("home / end で行頭・行末へ移動する", () => {
    expect(applyEditKey(st("あいう", 2), key({ name: "home" }))).toEqual(st("あいう", 0));
    expect(applyEditKey(st("あいう", 1), key({ name: "end" }))).toEqual(st("あいう", 3));
  });

  test("印字可能文字をカーソル位置に挿入する（変換しない）", () => {
    expect(applyEditKey(st("あう", 1), key({ name: "k", sequence: "い" }))).toEqual(
      st("あいう", 2),
    );
    // ローマ字も素のまま入る（かな変換されない）
    expect(applyEditKey(st("", 0), key({ name: "k", sequence: "k" }))).toEqual(st("k", 1));
  });

  test("space はカーソル位置に空白を挿入する", () => {
    expect(applyEditKey(st("ab", 1), key({ name: "space", sequence: " " }))).toEqual(st("a b", 2));
  });

  test("backspace はカーソル手前の 1 文字を削る（先頭では無効）", () => {
    expect(applyEditKey(st("あいう", 2), key({ name: "backspace" }))).toEqual(st("あう", 1));
    expect(applyEditKey(st("あいう", 0), key({ name: "backspace" }))).toEqual(st("あいう", 0));
  });

  test("delete はカーソル位置の 1 文字を削る（末尾では無効）", () => {
    expect(applyEditKey(st("あいう", 1), key({ name: "delete" }))).toEqual(st("あう", 1));
    expect(applyEditKey(st("あいう", 3), key({ name: "delete" }))).toEqual(st("あいう", 3));
  });

  test("ctrl / meta 併用と未対応キーは状態を変えない", () => {
    expect(applyEditKey(st("a", 1), key({ name: "a", sequence: "a", ctrl: true }))).toEqual(
      st("a", 1),
    );
    expect(applyEditKey(st("a", 1), key({ name: "f1", sequence: "OP" }))).toEqual(st("a", 1));
  });
});
