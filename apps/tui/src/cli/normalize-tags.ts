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
} from "@zakki/backend/analysis/normalizer.ts";
import { createDb, defaultDbPath } from "@zakki/data/db/client.ts";
import { cosine } from "@zakki/data/embedding/vector.ts";
import { createRuriEmbedder } from "@zakki/backend/embedding/embedder.ts";
import { countTags, listTagsByChunk } from "@zakki/data/chunk/queries.ts";
import { xdgDataHome } from "@zakki/data/util/paths.ts";
import { loadConfigOrExit } from "@zakki/tui/config.ts";
import { detectLlm } from "@zakki/backend/llm/client.ts";

// 合成点: 環境変数を起動時に一度だけ検証する（issue #48）
const config = loadConfigOrExit(process.env);

const apply = process.argv.includes("--apply");
const db = await createDb(defaultDbPath(xdgDataHome(config.xdgDataHome)));

const counts = countTags((await listTagsByChunk(db))._unsafeUnwrap());
const tagCounts: TagWithCount[] = [...counts.entries()].map(([name, count]) => ({ name, count }));
if (tagCounts.length < 2) {
  console.log("タグが少ないため提案はありません");
  process.exit(0);
}

// タグ名の embedding 類似（無効化時は編集距離のみ）
let similarity: ((a: string, b: string) => number) | undefined;
if (!config.noEmbedding) {
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
const llm = await detectLlm({ baseUrl: config.llmBaseUrl, model: config.llmModel });
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
  const result = (await applyTagMerges(db, proposals))._unsafeUnwrap();
  console.log(`適用しました: ${result.merged} 件`);
} else {
  console.log("適用するには --apply を付けてください");
}
