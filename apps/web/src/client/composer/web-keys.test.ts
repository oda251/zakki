import { describe, expect, test } from "bun:test";
import { toKeyLike } from "./web-keys.ts";

const ev = (key: string, over: Partial<Parameters<typeof toKeyLike>[0]> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...over,
});

describe("toKeyLike（KeyboardEvent → KeyLike ゲート）", () => {
  test("ASCII 印字文字は name/sequence に写す", () => {
    expect(toKeyLike(ev("a"))).toEqual({ name: "a", sequence: "a", ctrl: false, meta: false });
    expect(toKeyLike(ev("K"))).toEqual({ name: "k", sequence: "K", ctrl: false, meta: false });
    expect(toKeyLike(ev("."))).toEqual({ name: ".", sequence: ".", ctrl: false, meta: false });
  });

  test("名前付きキーは core の名前へ写す", () => {
    expect(toKeyLike(ev("Backspace"))?.name).toBe("backspace");
    expect(toKeyLike(ev("Enter"))?.name).toBe("enter");
    expect(toKeyLike(ev("Tab"))?.name).toBe("tab");
    expect(toKeyLike(ev(" "))).toEqual({ name: "space", sequence: " ", ctrl: false, meta: false });
  });

  test("IME 変換中（isComposing）は null（compositionend 側が拾う）", () => {
    expect(toKeyLike(ev("a", { isComposing: true }))).toBeNull();
    expect(toKeyLike(ev("Process", { isComposing: true }))).toBeNull();
  });

  test("非 ASCII の単一文字はローマ字模型に入れない", () => {
    expect(toKeyLike(ev("あ"))).toBeNull();
    expect(toKeyLike(ev("漢"))).toBeNull();
  });

  test("修飾キーは KeyLike に伝播する", () => {
    expect(toKeyLike(ev("c", { ctrlKey: true }))).toEqual({
      name: "c",
      sequence: "c",
      ctrl: true,
      meta: false,
    });
  });

  test("未対応キーは null（ブラウザ既定動作に任せる）", () => {
    expect(toKeyLike(ev("F5"))).toBeNull();
    expect(toKeyLike(ev("Shift"))).toBeNull();
  });
});
