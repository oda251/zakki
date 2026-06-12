import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { AncoEngine, defaultAncoPath } from "./engine.ts";

// anco バイナリ導入済み環境（scripts/install-anco.sh 実行後）でのみ動く統合テスト。
// 期待値は AzooKeyKanaKanjiConverter v0.11.2 同梱辞書（N-gram、zenz なし）の実測値。
const ancoPath = defaultAncoPath();
const hasAnco = existsSync(ancoPath);

describe.skipIf(!hasAnco)("AncoEngine（実バイナリ統合）", () => {
  test("かな→漢字変換・文脈考慮・直列化", async () => {
    const engine = new AncoEngine(ancoPath);
    try {
      const plain = await engine.convert("きょうははれ");
      expect(plain._unsafeUnwrap()).toBe("今日は貼れ");

      // 左文脈で変換が変わる
      const withContext = await engine.convert("はしをわたる", "川にかかる。");
      expect(withContext._unsafeUnwrap()).toBe("橋を渡る");

      // 同時リクエストは直列化され、すべて成功する
      const results = await Promise.all([
        engine.convert("にほんごにゅうりょく"),
        engine.convert("じどうほぞん"),
        engine.convert("ざっき"),
      ]);
      for (const result of results) {
        expect(result.isOk()).toBe(true);
      }
      expect(results[0]._unsafeUnwrap()).toBe("日本語入力");
    } finally {
      engine.close();
    }
  }, 30_000);

  test("改行を含む入力はエラー", async () => {
    const engine = new AncoEngine(ancoPath);
    const result = await engine.convert("ふくすう\nぎょう");
    expect(result.isErr()).toBe(true);
    engine.close();
  });
});

test.skipIf(hasAnco)("anco 未導入のため統合テストはスキップ", () => {
  expect(hasAnco).toBe(false);
});
