import { describe, expect, test } from "bun:test";
import { scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import type { TagScore } from "./tagger.ts";
import { planWrites, tagListEquals } from "./plan.ts";

const t = (name: string, score: number): TagScore => ({ name, score });

describe("tagListEquals", () => {
  test("名前・スコア・順序の完全一致のみ true", () => {
    expect(tagListEquals([t("a", 1)], [t("a", 1)])).toBe(true);
    expect(tagListEquals([t("a", 1)], [t("a", 2)])).toBe(false);
    expect(tagListEquals([t("a", 1), t("b", 0.5)], [t("b", 0.5), t("a", 1)])).toBe(false);
    expect(tagListEquals([], undefined)).toBe(false);
  });
});

describe("planWrites の bump 判定（増分パス）", () => {
  const content = "嬉しい記録。";
  const polarity = scoreSentiment(content);

  test("極性同値 + 可視タグ名列同値 → bump しない（極性は書く）", () => {
    const plan = planWrites({
      newTags: new Map([[1, [t("記録", 0.9)]]]),
      oldTags: new Map([[1, [t("記録", 0.5)]]]), // スコアだけ変化 = 名前列は同じ
      contentById: new Map([[1, content]]),
      oldPolarity: new Map([[1, polarity]]),
      changed: new Set([1]),
      links: [],
    });
    expect(plan.polarityWrites).toEqual([{ chunkId: 1, polarity, bump: false }]);
    // スコア変化はタグ張替えの対象にはなる（DB 状態を全量再計算と一致させる）
    expect(plan.tagRewrites.map((r) => r.chunkId)).toEqual([1]);
  });

  test("自身の可視タグ名列が変化 → bump する", () => {
    const plan = planWrites({
      newTags: new Map([[1, [t("新タグ", 0.9)]]]),
      oldTags: new Map([[1, [t("旧タグ", 0.9)]]]),
      contentById: new Map([[1, content]]),
      oldPolarity: new Map([[1, polarity]]),
      changed: new Set([1]),
      links: [],
    });
    expect(plan.polarityWrites).toEqual([{ chunkId: 1, polarity, bump: true }]);
  });

  test("corpus 変動で他チャンクのタグだけが揺れても、その他チャンクは bump 対象外", () => {
    const plan = planWrites({
      newTags: new Map([
        [1, [t("a", 0.9)]],
        [2, [t("b", 0.9)]], // 2 は changed でない（corpus 由来の揺れ）
      ]),
      oldTags: new Map([
        [1, [t("a", 0.9)]],
        [2, [t("c", 0.9)]],
      ]),
      contentById: new Map([
        [1, content],
        [2, "別の記録。"],
      ]),
      oldPolarity: new Map([
        [1, polarity],
        [2, scoreSentiment("別の記録。")],
      ]),
      changed: new Set([1]),
      links: [],
    });
    // 2 のタグ張替えは行う（DB 状態の一致）が、polarityWrites（bump 経路）には現れない
    expect(plan.tagRewrites.map((r) => r.chunkId)).toEqual([2]);
    expect(plan.polarityWrites.map((w) => w.chunkId)).toEqual([1]);
    expect(plan.relinkChunkIds).toEqual([1]);
  });

  test("全量パス（changed='all'）は bump するチャンクだけ極性を書く（冪等再実行で無変更）", () => {
    const plan = planWrites({
      newTags: new Map([[1, [t("a", 0.9)]]]),
      oldTags: new Map([[1, [t("a", 0.9)]]]),
      contentById: new Map([[1, content]]),
      oldPolarity: new Map([[1, polarity]]),
      changed: "all",
      links: [],
    });
    expect(plan.polarityWrites).toEqual([]);
    expect(plan.relinkChunkIds).toBe("all");
  });
});
