/**
 * デイリー / ウィークリーダイジェスト CLI（docs/FEATURES.md 候補4）。
 *   bun run digest               … 当日
 *   bun run digest 2026-06-12   … 指定日
 *   bun run digest --week       … 直近 7 日
 * vault の digests/ に書き出し、標準出力にも表示する。
 * Ollama（qwen3 系）が起動していれば要約を付け、なければ決定的集計のみ。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateDigest } from "@/digest/digest.ts";
import { createDb } from "@/db/client.ts";
import { localDate } from "@/entry/autosave.ts";
import { listChunksWithDate, listTagsByChunk } from "@/entry/queries.ts";
import { defaultVaultDir } from "@/export/obsidian.ts";
import { detectLlm } from "@/llm/client.ts";

const args = process.argv.slice(2);
const week = args.includes("--week");
const endDate = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? localDate();

const dates = new Set<string>();
if (week) {
  const end = new Date(`${endDate}T00:00:00`);
  for (let i = 0; i < 7; i++) {
    dates.add(localDate(new Date(end.getTime() - i * 86_400_000)));
  }
} else {
  dates.add(endDate);
}
const period = week ? `${[...dates].toSorted()[0]} 〜 ${endDate}` : endDate;

const db = createDb();
const chunks = listChunksWithDate(db)
  ._unsafeUnwrap()
  .filter((c) => dates.has(c.date));
const tagsByChunk = listTagsByChunk(db)._unsafeUnwrap();
const tagCounts = new Map<string, number>();
for (const chunk of chunks) {
  for (const name of tagsByChunk.get(chunk.id) ?? []) {
    tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
  }
}

const llm = await detectLlm();
const digest = await generateDigest({ period, chunks, tagCounts }, llm);

const file = join(defaultVaultDir(), "digests", `${week ? `week-${endDate}` : endDate}.md`);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, digest, "utf8");

console.log(digest);
console.log(`書き出し: ${file}${llm === null ? "（LLM なし・決定的集計のみ）" : ""}`);
