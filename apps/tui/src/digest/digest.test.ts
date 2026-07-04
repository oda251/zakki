import { describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { TextGenerator } from "@zakki/backend/llm/client.ts";
import { deterministicDigest, generateDigest } from "./digest.ts";

const input = {
  period: "2026-06-13",
  chunks: [
    { date: "2026-06-13", content: "変換の実装をした。" },
    { date: "2026-06-13", content: "散歩した。" },
  ],
  tagCounts: new Map([
    ["変換", 2],
    ["散歩", 1],
  ]),
};

describe("deterministicDigest", () => {
  test("チャンク数・タグ頻度・タイトル一覧を含む", () => {
    const digest = deterministicDigest(input);
    expect(digest).toContain("# ふりかえり 2026-06-13");
    expect(digest).toContain("チャンク数: 2");
    expect(digest).toContain("変換（2）、散歩（1）");
    expect(digest).toContain("- 2026-06-13 変換の実装をした。");
  });

  test("気分（ネガポジ平均）の行を含む", () => {
    const digest = deterministicDigest(input);
    expect(digest).toContain("気分:");
    expect(digest).toContain("ポジ");
  });
});

describe("generateDigest", () => {
  test("LLM なしは決定的ダイジェストのみ", async () => {
    const digest = await generateDigest(input, null);
    expect(digest).toBe(deterministicDigest(input));
  });

  test("LLM ありは要約を付加する", async () => {
    const llm: TextGenerator = {
      name: "fake",
      generate: () => okAsync("変換を実装し、散歩もした。"),
    };
    const digest = await generateDigest(input, llm);
    expect(digest).toContain("## 要約（fake）");
    expect(digest).toContain("変換を実装し、散歩もした。");
  });

  test("LLM 失敗時は決定的ダイジェストへフォールバック", async () => {
    const llm: TextGenerator = {
      name: "fake",
      generate: () => errAsync({ type: "llm-error", message: "down" }),
    };
    expect(await generateDigest(input, llm)).toBe(deterministicDigest(input));
  });
});
