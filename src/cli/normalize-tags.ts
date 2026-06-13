/**
 * タグ統廃合 CLI（docs/FEATURES.md 候補6）。提案ベースで、適用は明示時のみ。
 *   bun run tags           … 統合提案を表示
 *   bun run tags --apply   … 提案を適用
 * 判定材料: 編集距離（表記揺れ）+ タグ名 embedding 類似。
 * Ollama がいれば embedding 由来の提案を類義判定でフィルタする。
 */
import {
  applyTagMerges,
  filterProposalsWithLlm,
  proposeTagMerges,
  type TagWithCount,
} from "@/analysis/normalizer.ts";
import { createDb } from "@/db/client.ts";
import { cosine, createRuriEmbedder } from "@/embedding/embedder.ts";
import { listTagsByChunk } from "@/entry/queries.ts";
import { detectLlm } from "@/llm/client.ts";

const apply = process.argv.includes("--apply");
const db = createDb();

const counts = new Map<string, number>();
for (const names of listTagsByChunk(db)._unsafeUnwrap().values()) {
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
}
const tagCounts: TagWithCount[] = [...counts.entries()].map(([name, count]) => ({ name, count }));
if (tagCounts.length < 2) {
  console.log("タグが少ないため提案はありません");
  process.exit(0);
}

// タグ名の embedding 類似（無効化時は編集距離のみ）
let similarity: ((a: string, b: string) => number) | undefined;
if (process.env["ZAKKI_NO_EMBEDDING"] !== "1") {
  const embedder = createRuriEmbedder();
  const names = tagCounts.map((t) => t.name);
  const vectors = await embedder.embed(names).catch(() => null);
  if (vectors !== null) {
    const byName = new Map(names.map((name, i) => [name, vectors[i]]));
    similarity = (a, b) => {
      const va = byName.get(a);
      const vb = byName.get(b);
      return va === undefined || vb === undefined ? 0 : cosine(va, vb);
    };
  }
}

let proposals = proposeTagMerges(tagCounts, similarity);
const llm = await detectLlm();
if (llm !== null) {
  proposals = await filterProposalsWithLlm(proposals, llm);
}

if (proposals.length === 0) {
  console.log("統合提案はありません");
  process.exit(0);
}
for (const p of proposals) {
  console.log(`${p.from} → ${p.to}（${p.reason}）`);
}
if (apply) {
  const result = applyTagMerges(db, proposals)._unsafeUnwrap();
  console.log(`適用しました: ${result.merged} 件`);
} else {
  console.log("適用するには --apply を付けてください");
}
