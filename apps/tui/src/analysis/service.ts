import { eq, sql } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
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
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const rawChunks = await db.select({ id: chunks.id, content: chunks.content }).from(chunks);
    // 解析（名詞抽出・極性）は平文に対して行う。暗号 ON は復号した content を使う。
    const allChunks = rawChunks.map((c) => ({
      id: c.id,
      content: crypto === undefined ? c.content : crypto.decString(c.content, "chunk.content"),
    }));

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
      // タグは平文名で一意化するが、格納は name=暗号文 / name_fingerprint=ブラインド
      // インデックス。暗号 OFF は fingerprint=平文名で従来どおりの重複排除になる。
      const fpOf = (name: string) => (crypto === undefined ? name : crypto.fingerprint(name));
      for (const name of names) {
        const stored = crypto === undefined ? name : crypto.encString(name, "tag.name");
        await tx
          .insert(tags)
          .values({ name: stored, nameFingerprint: fpOf(name), createdAt: now })
          .onConflictDoNothing({ target: tags.nameFingerprint });
      }
      // 平文タグ名 → id を引けるよう fingerprint で突き合わせる
      const idByFingerprint = new Map(
        (await tx.select().from(tags)).map((r) => [r.nameFingerprint, r.id]),
      );
      const idByName = new Map([...names].map((name) => [name, idByFingerprint.get(fpOf(name))]));

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
