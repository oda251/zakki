import { describe, expect, test } from "bun:test";
import { cosine } from "@zakki/data/embedding/vector.ts";
import { EMBEDDING_DIMS } from "@zakki/core/embedding/types.ts";
import { createRuriEmbedder } from "./embedder.ts";

// ruri-v3-30m（非公式 ONNX、q8）の実モデル統合テスト。
// 初回はモデルダウンロードが走る（約37MB、以後キャッシュ）。
describe("createRuriEmbedder（実モデル統合）", () => {
  test("256 次元・言い換えが無関係文より近い（出力一致検証の回帰）", async () => {
    const embedder = createRuriEmbedder();
    const [a, b, c] = await embedder.embed([
      "自動保存の実装",
      "データを自動で保存する機能",
      "今日の天気は晴れ",
    ]);
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error("embedding missing");
    }
    expect(a.length).toBe(EMBEDDING_DIMS);
    const paraphrase = cosine(a, b);
    const unrelated = cosine(a, c);
    // 実測（2026-06-13）: 0.935 vs 0.787
    expect(paraphrase).toBeGreaterThan(0.9);
    expect(unrelated).toBeLessThan(0.85);
  }, 180_000);
});
