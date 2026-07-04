import { describe, expect, test } from "bun:test";
import { sessionTitle } from "./session-title.ts";

describe("sessionTitle（左メニューのセッション表示名）", () => {
  test("デフォルトセッション（name null）は日付 YYYY-MM-DD そのもの", () => {
    expect(sessionTitle({ name: null, date: "2026-07-05" })).toBe("2026-07-05");
  });

  test("名前付きセッションは名前", () => {
    expect(sessionTitle({ name: "調査", date: "2026-07-05" })).toBe("調査");
  });
});
