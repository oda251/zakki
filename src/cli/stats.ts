/**
 * 日ごとのネガポジ統計 CLI（docs/FEATURES.md §整理・想起系 7）。
 *   bun run stats   … 全期間を日付順に表示し、vault の digests/mood.md にも書き出す
 *
 * 永続化された chunks.polarity を SQL 集計する。先に analyzeAll を流して
 * 未解析チャンクの極性も最新化してから集計する（決定的・冪等）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analyzeAll } from "@/analysis/service.ts";
import { fmtPolarity, moodLabel } from "@/analysis/sentiment.ts";
import { createDb } from "@/db/client.ts";
import { dailySentiment } from "@/entry/queries.ts";
import { defaultVaultDir } from "@/export/obsidian.ts";

const db = createDb();
analyzeAll(db)._unsafeUnwrap();
const rows = dailySentiment(db)._unsafeUnwrap();

const lines = [
  "# 気分の推移",
  "",
  "| 日付 | チャンク | 平均 | 気分 | ポジ | ネガ | 中立 |",
  "| --- | ---: | ---: | --- | ---: | ---: | ---: |",
  ...rows.map((r) => {
    const mood = r.average === null ? "-" : moodLabel(r.average);
    return `| ${r.date} | ${r.chunks} | ${fmtPolarity(r.average)} | ${mood} | ${r.positive} | ${r.negative} | ${r.neutral} |`;
  }),
  "",
];
const output = rows.length === 0 ? "# 気分の推移\n\nデータがありません。\n" : lines.join("\n");

const file = join(defaultVaultDir(), "digests", "mood.md");
await mkdir(dirname(file), { recursive: true });
await writeFile(file, output, "utf8");

console.log(output);
console.log(`書き出し: ${file}`);
