import { describe, expect, test } from "bun:test";
import { createConversionSession } from "./compose.ts";
import { identityEngine } from "./engine.ts";
import { PASTE_OPEN, wrapPaste } from "./paste.ts";

const session = () =>
  createConversionSession(identityEngine, {
    onUpdate: () => {},
    onError: () => {},
    onChosen: () => {},
    onConverted: () => {},
  });

describe("createConversionSession", () => {
  test("convertRaw は凍結リテラルのマーカーを温存する（チャンク境界を保存経路へ伝える）", () => {
    // Enter 終端（句点なし）で凍結された 2 文。マーカーだけが境界
    const raw = wrapPaste("ぶにち") + wrapPaste("ぶんい");
    const { text } = session().convertRaw(raw);
    expect(text).toContain(PASTE_OPEN);
    expect(text).toBe(raw);
  });

  test("convertLive は表示用に strip 済みを返す（マーカーを含まない）", () => {
    const { text, pending } = session().convertLive("aik");
    expect(text).not.toContain(PASTE_OPEN);
    expect(text).toBe("あい");
    expect(pending).toBe("k");
  });
});
