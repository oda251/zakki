import { fmtPolarity, moodLabel, moodOf, scoreSentiment } from "@/analysis/sentiment.ts";
import type { TextGenerator } from "@/llm/client.ts";

/**
 * デイリー / ウィークリーダイジェスト（docs/FEATURES.md 候補4）。
 * 基本はチャンクタイトル + タグ頻度の決定的集計。LLM があれば要約文を加える
 * （生成失敗時は決定的部分のみにフォールバック）。
 */

export interface DigestInput {
  /** 見出しに使う期間表記（例: "2026-06-13" や "2026-06-07 〜 2026-06-13"） */
  period: string;
  chunks: { date: string; title: string; content: string }[];
  /** タグ名 → 出現チャンク数 */
  tagCounts: ReadonlyMap<string, number>;
}

const TOP_TAGS = 5;

export function deterministicDigest(input: DigestInput): string {
  const lines = [`# ふりかえり ${input.period}`, ""];
  lines.push(`チャンク数: ${input.chunks.length}`);

  // 気分（決定的ネガポジ極性, docs/FEATURES.md §整理・想起系 10）。本文から都度算出
  if (input.chunks.length > 0) {
    const { sum, counts } = input.chunks.reduce(
      (acc, c) => {
        const s = scoreSentiment(c.content);
        acc.sum += s;
        acc.counts[moodOf(s)]++;
        return acc;
      },
      { sum: 0, counts: { positive: 0, negative: 0, neutral: 0 } },
    );
    const avg = sum / input.chunks.length;
    lines.push(
      `気分: ${moodLabel(avg)}（平均 ${fmtPolarity(avg)}` +
        `｜ポジ ${counts.positive}・ネガ ${counts.negative}・中立 ${counts.neutral}）`,
    );
  }

  const topTags = [...input.tagCounts.entries()]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TAGS);
  if (topTags.length > 0) {
    lines.push(`よく出たタグ: ${topTags.map(([name, n]) => `${name}（${n}）`).join("、")}`);
  }

  lines.push("", "## 書いたこと", "");
  for (const chunk of input.chunks) {
    lines.push(`- ${chunk.date} ${chunk.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** LLM 要約付きダイジェスト。LLM なし・チャンクなし・失敗時は決定的ダイジェストのみ */
export async function generateDigest(
  input: DigestInput,
  llm: TextGenerator | null,
): Promise<string> {
  const base = deterministicDigest(input);
  if (llm === null || input.chunks.length === 0) {
    return base;
  }
  const body = input.chunks.map((c) => `- ${c.content}`).join("\n");
  const prompt = [
    "以下はジャーナリングアプリの記録です。日本語で 3 行以内に要約してください。",
    "事実のみを書き、前置きや感想は不要です。",
    "",
    body,
  ].join("\n");
  const summary = await llm.generate(prompt);
  return summary.match(
    (text) => `${base}\n## 要約（${llm.name}）\n\n${text}\n`,
    () => base,
  );
}
