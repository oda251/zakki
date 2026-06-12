import { describe, expect, test } from "bun:test";
import { errAsync, ResultAsync } from "neverthrow";
import type { EngineError, KanaKanjiEngine } from "./engine.ts";
import { ConversionPipeline } from "./pipeline.ts";

/** 解決タイミングを制御できるフェイクエンジン */
function deferredEngine(): {
  engine: KanaKanjiEngine;
  resolve: (kana: string, candidates: string[]) => void;
  requests: { kana: string; leftContext: string | undefined }[];
} {
  const handlers = new Map<string, (candidates: string[]) => void>();
  const requests: { kana: string; leftContext: string | undefined }[] = [];
  return {
    engine: {
      name: "deferred",
      convert: (kana, leftContext) => {
        requests.push({ kana, leftContext });
        return ResultAsync.fromSafePromise(new Promise<string[]>((res) => handlers.set(kana, res)));
      },
      close: () => {},
    },
    resolve: (kana, candidates) => {
      handlers.get(kana)?.(candidates);
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

    resolve("きょうははれ。", ["今日は晴れ。", "今日は腫れ。"]);
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
    resolve("かわにかかる。", ["川にかかる。"]);
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
    resolve("はれ。", ["晴れ。"]);
    await tick();

    pipeline.apply("はれ。"); // キャッシュヒット
    expect(requests).toHaveLength(1);

    pipeline.apply("はれた。"); // 編集後は別セグメント
    expect(requests).toHaveLength(2);
    expect(requests[1]?.kana).toBe("はれた。");
  });

  test("rotate は候補を巡回し onChosen に確定値を返す", async () => {
    const { engine, resolve } = deferredEngine();
    const pipeline = new ConversionPipeline(engine, () => {});

    pipeline.apply("はしをわたる。");
    resolve("はしをわたる。", ["橋を渡る。", "箸を渡る。", "端を渡る。"]);
    await tick();

    const chosen: string[] = [];
    pipeline.rotate("はしをわたる。", (c) => chosen.push(c));
    expect(chosen).toEqual(["箸を渡る。"]);
    expect(pipeline.apply("はしをわたる。").text).toBe("箸を渡る。");

    pipeline.rotate("はしをわたる。", (c) => chosen.push(c));
    pipeline.rotate("はしをわたる。", (c) => chosen.push(c));
    // 3 候補を巡回して先頭へ戻る
    expect(chosen).toEqual(["箸を渡る。", "端を渡る。", "橋を渡る。"]);
  });

  test("overrides（学習済み修正）は最優先で使われ、rotate 時は候補を取得して巡回する", async () => {
    const { engine, resolve, requests } = deferredEngine();
    const pipeline = new ConversionPipeline(
      engine,
      () => {},
      () => {},
      new Map([["はれ。", "貼れ。"]]),
    );

    // 変換リクエストなしで学習値が使われる
    expect(pipeline.apply("はれ。")).toEqual({ text: "貼れ。", converting: 0 });
    expect(requests).toHaveLength(0);

    // rotate は候補リストを取得し、学習値の次の候補へ進む
    const chosen: string[] = [];
    pipeline.rotate("はれ。", (c) => chosen.push(c));
    resolve("はれ。", ["晴れ。", "貼れ。"]);
    await tick();
    expect(chosen).toEqual(["晴れ。"]);
    expect(pipeline.apply("はれ。").text).toBe("晴れ。");
  });

  test("失敗はリトライ上限後にかなのまま確定する", async () => {
    let calls = 0;
    const failing: KanaKanjiEngine = {
      name: "failing",
      convert: () => {
        calls += 1;
        return errAsync<string[], EngineError>({
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
