import { beforeEach, describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import { analyzeAll } from "@zakki/backend/analysis/service.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import { listTagsByChunk } from "@zakki/data/chunk/queries.ts";
import type { TextGenerator } from "@zakki/backend/llm/client.ts";
import {
  applyTagMerges,
  filterProposalsWithLlm,
  levenshtein,
  proposeTagMerges,
} from "./normalizer.ts";

describe("levenshtein", () => {
  test("基本ケース", () => {
    expect(levenshtein("かんが", "かんがえ")).toBe(1);
    expect(levenshtein("同じ", "同じ")).toBe(0);
    expect(levenshtein("abc", "xyz")).toBe(3);
  });
});

describe("proposeTagMerges", () => {
  test("編集距離 1 の表記揺れは出現数が多い方へ統合", () => {
    const proposals = proposeTagMerges([
      { name: "ジャーナル", count: 5 },
      { name: "ジャーナリ", count: 1 },
      { name: "散歩", count: 3 },
    ]);
    expect(proposals).toEqual([{ from: "ジャーナリ", to: "ジャーナル", reason: "edit-distance" }]);
  });

  test("短いタグは編集距離では統合しない（誤爆防止）", () => {
    expect(
      proposeTagMerges([
        { name: "犬", count: 2 },
        { name: "猫", count: 2 },
      ]),
    ).toEqual([]);
  });

  test("embedding 類似による提案", () => {
    const proposals = proposeTagMerges(
      [
        { name: "日記", count: 4 },
        { name: "ジャーナル", count: 2 },
      ],
      (a, b) => (a === "日記" && b === "ジャーナル" ? 0.95 : 0),
    );
    expect(proposals).toEqual([{ from: "ジャーナル", to: "日記", reason: "embedding" }]);
  });
});

describe("filterProposalsWithLlm", () => {
  test("embedding 由来のみ LLM 判定し、no は落とす", async () => {
    const llm: TextGenerator = {
      name: "fake",
      generate: (prompt) => okAsync(prompt.includes("日記") ? "yes" : "no"),
    };
    const filtered = await filterProposalsWithLlm(
      [
        { from: "メモ", to: "ノート", reason: "embedding" },
        { from: "日誌", to: "日記", reason: "embedding" },
        { from: "さんぽ", to: "さんぽう", reason: "edit-distance" },
      ],
      llm,
    );
    expect(filtered).toEqual([
      { from: "日誌", to: "日記", reason: "embedding" },
      { from: "さんぽ", to: "さんぽう", reason: "edit-distance" },
    ]);
  });
});

describe("applyTagMerges", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createDb(":memory:");
  });

  test("chunk_tags を代表タグへ付け替え、統合元タグを消す", async () => {
    await seedDayChunks(db, "2026-06-13", ["変換辞書と学習辞書の話。", "変換器の辞書の続き。"]);
    (await analyzeAll(db))._unsafeUnwrap();

    const before = (await listTagsByChunk(db))._unsafeUnwrap();
    const names = new Set([...before.values()].flat());
    expect(names.has("辞書")).toBe(true);

    // 「変換」を「辞書」に統合する仮の提案を適用
    (await applyTagMerges(db, [{ from: "変換", to: "辞書", reason: "embedding" }]))._unsafeUnwrap();

    const after = new Set([...(await listTagsByChunk(db))._unsafeUnwrap().values()].flat());
    expect(after.has("変換")).toBe(false);
    expect(after.has("辞書")).toBe(true);
  });
});
