import { describe, expect, test } from "bun:test";
import { identityEngine } from "./engine.ts";

describe("identityEngine", () => {
  test("かなをそのまま返す（anco 未統合時のフォールバック）", async () => {
    const result = await identityEngine.convert("きょうははれ。");
    expect(result._unsafeUnwrap()).toBe("きょうははれ。");
  });

  test("close は何もしない", () => {
    expect(() => identityEngine.close()).not.toThrow();
  });
});
