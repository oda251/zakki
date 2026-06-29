import { describe, expect, test } from "bun:test";
import type { KeyLike } from "./controller.ts";
import type { Action } from "./keymap.ts";
import { matchesAction } from "./keymap.ts";

function key(partial: Partial<KeyLike> & { name: string }): KeyLike {
  return { sequence: "", ctrl: false, meta: false, ...partial };
}

/** action ごとに「該当する代表キー」と「該当しない代表キー」を網羅する */
describe("matchesAction", () => {
  test("移動アクションは同名キー（修飾なし）に該当する", () => {
    const dirs: Action[] = ["up", "down", "left", "right"];
    for (const dir of dirs) {
      expect(matchesAction(key({ name: dir }), dir)).toBe(true);
      // 修飾付きは該当しない
      expect(matchesAction(key({ name: dir, ctrl: true }), dir)).toBe(false);
      expect(matchesAction(key({ name: dir, meta: true }), dir)).toBe(false);
      // 別名キーは該当しない
      expect(matchesAction(key({ name: "x" }), dir)).toBe(false);
    }
  });

  test("edit は e（Ctrl/Meta なし）のみ", () => {
    expect(matchesAction(key({ name: "e", sequence: "e" }), "edit")).toBe(true);
    expect(matchesAction(key({ name: "e", sequence: "e", ctrl: true }), "edit")).toBe(false);
    expect(matchesAction(key({ name: "e", sequence: "e", meta: true }), "edit")).toBe(false);
    expect(matchesAction(key({ name: "d", sequence: "d" }), "edit")).toBe(false);
  });

  test("delete は d（Ctrl/Meta なし）または Delete", () => {
    expect(matchesAction(key({ name: "d", sequence: "d" }), "delete")).toBe(true);
    expect(matchesAction(key({ name: "delete" }), "delete")).toBe(true);
    // Delete は修飾に関係なく該当する（key.name === "delete"）
    expect(matchesAction(key({ name: "delete", ctrl: true }), "delete")).toBe(true);
    // Ctrl+d は delete ではない（exit 等と衝突回避）
    expect(matchesAction(key({ name: "d", sequence: "d", ctrl: true }), "delete")).toBe(false);
    expect(matchesAction(key({ name: "d", sequence: "d", meta: true }), "delete")).toBe(false);
    expect(matchesAction(key({ name: "e", sequence: "e" }), "delete")).toBe(false);
  });

  test("submit は Enter（return/enter）のみ", () => {
    expect(matchesAction(key({ name: "return" }), "submit")).toBe(true);
    expect(matchesAction(key({ name: "enter" }), "submit")).toBe(true);
    expect(matchesAction(key({ name: "space", sequence: " " }), "submit")).toBe(false);
    expect(matchesAction(key({ name: "escape" }), "submit")).toBe(false);
  });

  test("select は Space または Enter（submit を含む）", () => {
    expect(matchesAction(key({ name: "space", sequence: " " }), "select")).toBe(true);
    expect(matchesAction(key({ name: "return" }), "select")).toBe(true);
    expect(matchesAction(key({ name: "enter" }), "select")).toBe(true);
    expect(matchesAction(key({ name: "escape" }), "select")).toBe(false);
    expect(matchesAction(key({ name: "a", sequence: "a" }), "select")).toBe(false);
  });

  test("cancel は Esc（escape）のみ", () => {
    expect(matchesAction(key({ name: "escape" }), "cancel")).toBe(true);
    expect(matchesAction(key({ name: "return" }), "cancel")).toBe(false);
    expect(matchesAction(key({ name: "c", sequence: "c", ctrl: true }), "cancel")).toBe(false);
  });

  test("Enter は submit かつ select の両方に該当する", () => {
    const enter = key({ name: "enter" });
    expect(matchesAction(enter, "submit")).toBe(true);
    expect(matchesAction(enter, "select")).toBe(true);
  });
});
