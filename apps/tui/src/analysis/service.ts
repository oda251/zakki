import { eq, sql } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, chunkTags, links, tags } from "@zakki/data/db/schema.ts";
import { computeLinks } from "./linker.ts";
import { scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import { computeTags } from "./tagger.ts";
import { extractNouns } from "./tokenizer.ts";

export interface AnalysisSummary {
  taggedChunks: number;
  links: number;
}

/** content → 名詞列のメモ（同一内容の再解析を避ける。プロセス内キャッシュ） */
const nounCache = new Map<string, string[]>();

/**
 * 全チャンクのタグ付けと関連付けを再計算して永続化する（docs/CONCEPT.md §3）。
 * 決定的・冪等な全量再計算。数千チャンク規模までを想定し、入力フローの外
 * （デバウンスされたバックグラウンド処理）で呼ぶ。
 */
export function analyzeAll(db: Db): ResultAsync<AnalysisSummary, DbError> {
  return tryDbAsync(async () => {
    const allChunks = await db.select({ id: chunks.id, content: chunks.content }).from(chunks);

    const nounsByChunk = new Map<number, string[]>();
    for (const chunk of allChunks) {
      let nouns = nounCache.get(chunk.content);
      if (nouns === undefined) {
        nouns = extractNouns(chunk.content);
        nounCache.set(chunk.content, nouns);
      }
      nounsByChunk.set(chunk.id, nouns);
    }

    const tagsByChunk = computeTags(nounsByChunk);
    const linkCandidates = computeLinks(nounsByChunk);
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      const names = new Set([...tagsByChunk.values()].flat().map((t) => t.name));
      for (const name of names) {
        await tx.insert(tags).values({ name, createdAt: now }).onConflictDoNothing();
      }
      const idByName = new Map((await tx.select().from(tags)).map((r) => [r.name, r.id]));

      await tx.delete(chunkTags);
      for (const [chunkId, tagList] of tagsByChunk) {
        for (const tag of tagList) {
          const tagId = idByName.get(tag.name);
          if (tagId !== undefined) {
            await tx.insert(chunkTags).values({ chunkId, tagId, score: tag.score });
          }
        }
      }
      // どのチャンクにも付かなくなったタグは削除する（乱立防止）
      await tx.run(sql`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM chunk_tags)`);

      await tx.delete(links).where(eq(links.origin, "auto"));
      for (const link of linkCandidates) {
        await tx
          .insert(links)
          .values({ ...link, origin: "auto" })
          .onConflictDoNothing();
      }

      // ネガポジ極性（決定的, docs/FEATURES.md §整理・想起系 7）を算出して永続化する
      for (const chunk of allChunks) {
        await tx
          .update(chunks)
          .set({ polarity: scoreSentiment(chunk.content) })
          .where(eq(chunks.id, chunk.id));
      }
    });

    return { taggedChunks: tagsByChunk.size, links: linkCandidates.length };
  });
}
