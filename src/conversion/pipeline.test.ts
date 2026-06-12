import { describe, expect, test } from "bun:test";
import { errAsync, ResultAsync } from "neverthrow";
import type { EngineError, KanaKanjiEngine } from "./engine.ts";
import { ConversionPipeline } from "./pipeline.ts";

/** 解決タイミングを制御できるフェイクエンジン */
function deferredEngine(): {
  engine: KanaKanjiEngine;
  resolve: (kana: string, converted: string) => void;
  requests: { kana: string; leftContext: string | undefined }[];
} {
  const handlers = new Map<string, (converted: string) => void>();
  const requests: { kana: string; leftContext: string | undefined }[] = [];
  return {
    engine: {
      name: "deferred",
      convert: (kana, leftContext) => {
        requests.push({ kana, leftContext });
        return ResultAsync.fromSafePromise(new Promise<string>((res) => handlers.set(kana, res)));
      },
      close: () => {},
    },
    resolve: (kana, converted) => {
      handlers.get(kana)?.(converted);
      handlers.delete(kana);
    },
    requests,
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("ConversionPipeline", () => {
  test("変換はタイピングをブロックせず、解決後に置換される", async () => {
    const { engine, resolve } = deferredEngine();
    let updates = 0;
    const pipeline = new ConversionPipeline(engine, () => {
      updates += 1;
    });

    // 未解決の間はかなのまま即時返す
    const first = pipeline.apply("きょうははれ。かきかけ");
    expect(first.text).toBe("きょうははれ。かきかけ");
    expect(first.converting).toBe(1);

    resolve("きょうははれ。", "今日は晴れ。");
    await tick();
    expect(updates).toBe(1);

    const second = pipeline.apply("きょうははれ。かきかけ");
    expect(second.text).toBe("今日は晴れ。かきかけ");
    expect(second.converting).toBe(0);
  });

  test("末尾の入力途中セグメントと改行は変換対象にしない", () => {
    const { engine, requests } = deferredEngine();
    const pipeline = new ConversionPipeline(engine, () => {});
    pipeline.apply("いちぎょうめ\nかきかけ");
    expect(requests.map((r) => r.kana)).toEqual(["いちぎょうめ"]);
  });

  test("文脈として直前セグメントの変換結果を渡す", async () => {
    const { engine, resolve, requests } = deferredEngine();
    const pipeline = new ConversionPipeline(engine, () => {});

    pipeline.apply("かわにかかる。");
    resolve("かわにかかる。", "川にかかる。");
    await tick();

    pipeline.apply("かわにかかる。はしをわたる。");
    const last = requests[requests.length - 1];
    expect(last?.kana).toBe("はしをわたる。");
    expect(last?.leftContext).toBe("川にかかる。");
  });

  test("編集でセグメントが変わると再変換、同一文は再投入しない", async () => {
    const { engine, resolve, requests } = deferredEngine();
    const pipeline = new ConversionPipeline(engine, () => {});

    pipeline.apply("はれ。");
    resolve("はれ。", "晴れ。");
    await tick();

    pipeline.apply("はれ。"); // キャッシュヒット
    expect(requests).toHaveLength(1);

    pipeline.apply("はれた。"); // 編集後は別セグメント
    expect(requests).toHaveLength(2);
    expect(requests[1]?.kana).toBe("はれた。");
  });

  test("失敗はリトライ上限後にかなのまま確定する", async () => {
    let calls = 0;
    const failing: KanaKanjiEngine = {
      name: "failing",
      convert: () => {
        calls += 1;
        return errAsync<string, EngineError>({
          type: "engine-error",
          message: "boom",
        });
      },
      close: () => {},
    };
    const errors: string[] = [];
    const pipeline = new ConversionPipeline(
      failing,
      () => {},
      (m) => errors.push(m),
    );

    for (let i = 0; i < 6; i++) {
      pipeline.apply("はれ。");
      await tick();
    }
    expect(calls).toBe(3);
    expect(errors).toHaveLength(3);
    expect(pipeline.apply("はれ。")).toEqual({
      text: "はれ。",
      converting: 0,
    });
  });
});
