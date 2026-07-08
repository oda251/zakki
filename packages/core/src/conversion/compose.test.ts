import { describe, expect, test } from "bun:test";
import { ResultAsync } from "neverthrow";
import { createConversionSession } from "./compose.ts";
import type { KanaKanjiEngine } from "./engine.ts";
import { identityEngine } from "./engine.ts";
import { PASTE_OPEN, wrapPaste } from "./paste.ts";

/** convert 呼び出し（= web では /api/convert 往復）を記録するスパイエンジン */
function spyEngine(): { engine: KanaKanjiEngine; calls: string[] } {
  const calls: string[] = [];
  return {
    engine: {
      name: "spy",
      convert: (kana) => {
        calls.push(kana);
        return ResultAsync.fromSafePromise(Promise.resolve([kana]));
      },
      close: () => {},
    },
    calls,
  };
}

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

  // issue #34 受け入れ基準: シード（cache/corrections）に載ったかなの変換で
  // エンジン（web では remoteEngine → /api/convert）を呼ばない。
  test("シード済みかなの変換はエンジンを呼ばない（キャッシュヒットのサーバ往復スキップ）", () => {
    const { engine, calls } = spyEngine();
    const conv = createConversionSession(engine, {
      onUpdate: () => {},
      onError: () => {},
      onChosen: () => {},
      onConverted: () => {},
      cache: new Map([["あれ。", "晴れ。"]]),
      corrections: new Map([["はれ。", "貼れ。"]]),
    });
    expect(conv.convertRaw("are.").text).toBe("晴れ。");
    expect(conv.convertRaw("hare.").text).toBe("貼れ。");
    // 未シードのかなだけがエンジンに到達する
    expect(conv.convertRaw("kaki.").text).toBe("かき。");
    expect(calls).toEqual(["かき。"]);
  });
});
