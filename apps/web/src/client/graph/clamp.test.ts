import { describe, expect, test } from "bun:test";
import { clampText, NODE_LABEL_MAX } from "./clamp.ts";

describe("clampText（ノードラベルの本文 clamp）", () => {
  test("max を超える本文はコードポイント単位で切り詰めて … を付ける", () => {
    expect(clampText("あいうえおかきくけこ", 5)).toBe("あいうえお…");
  });

  test("max 以下はそのまま返す（ellipsis なし）", () => {
    expect(clampText("あいうえお", 5)).toBe("あいうえお");
    expect(clampText("", 5)).toBe("");
  });

  test("改行は空白に畳んでから clamp する（複数行本文のラベル崩れ防止）", () => {
    expect(clampText("一行目\n二行目", 10)).toBe("一行目 二行目");
    expect(clampText("あい\nうえ\nおか\nきく", 5)).toBe("あい うえ…");
  });

  test("サロゲートペアを壊さない（コードポイント単位）", () => {
    expect(clampText("𠮷野家で𩸽を食べた", 4)).toBe("𠮷野家で…");
  });

  test("既定の clamp 長は 12", () => {
    expect(NODE_LABEL_MAX).toBe(12);
  });
});
