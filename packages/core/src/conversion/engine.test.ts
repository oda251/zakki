import { describe, expect, test } from "bun:test";
import { identityEngine } from "./engine.ts";

describe("identityEngine", () => {
  test("かなをそのまま唯一の候補として返す（anco 未導入時のフォールバック）", async () => {
    const result = await identityEngine.convert("きょうははれ。");
    expect(result._unsafeUnwrap()).toEqual(["きょうははれ。"]);
  });

  test("close は何もしない", () => {
    expect(() => identityEngine.close()).not.toThrow();
  });
});
