import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import { AAD } from "@zakki/core/crypto/aad.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, chunkTags, links, tags } from "@zakki/data/db/schema.ts";
import { batched } from "@zakki/data/util/batch.ts";

/**
 * 解析結果（タグ・リンク・極性）の永続化（issue #53）。
 * backend の解析サービス（planWrites）は「何を書くか」を純関数プランで宣言し、
 * 「どのテーブルにどう書くか」（schema・トランザクション境界）はここが握る。
 */

/** chunk_tags 1 行の平文表現（タグ名 + スコア）。タグ id は DB 採番のため名前で持つ */
export interface TagScore {
  name: string;
  score: number;
}

/**
 * 解析パス（backend/analysis の planWrites）が宣言する書き込み内容。
 * {@link applyAnalysisPlan} はこのプランを機械的に適用するだけ
 * （読み取り・判定・書き込みの交錯を解く）。
 */
export interface WritePlan {
  /** 確保すべきタグ名（tagRewrites で挿入するタグの名前集合） */
  tagNames: ReadonlySet<string>;
  /** chunk_tags を張り替えるチャンク（delete → insert）。新旧タグ列が変わったチャンクのみ */
  tagRewrites: { chunkId: number; tags: TagScore[] }[];
  /** auto リンクの張替え範囲。"all" = 全 auto を削除、配列 = そのチャンクが関与する auto のみ */
  relinkChunkIds: number[] | "all";
  /** 挿入する auto リンク（links 行の from/to/score。origin は適用時に "auto" 固定） */
  insertLinks: { fromChunkId: number; toChunkId: number; score: number }[];
  /** 極性の書き込み。bump = updatedAt を進めるか（差分取得が変更ノードを拾えるように） */
  polarityWrites: { chunkId: number; polarity: number; bump: boolean }[];
}

/** db.transaction のコールバック引数型（Db と同じクエリ面を持つ） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * tags テーブルへ名前を確保し、平文名 → tag id の対応を返す。
 * タグは平文名で一意化するが、格納は name=暗号文 / name_fingerprint=ブラインド
 * インデックス。暗号 OFF は fingerprint=平文名で従来どおりの重複排除になる。
 */
async function ensureTagIds(
  tx: Tx,
  crypto: CryptoContext | undefined,
  names: ReadonlySet<string>,
  now: string,
): Promise<Map<string, number | undefined>> {
  const fpOf = (name: string) => (crypto === undefined ? name : crypto.fingerprint(name));
  for (const name of names) {
    const stored = crypto === undefined ? name : crypto.encString(name, AAD.tagName);
    await tx
      .insert(tags)
      .values({ name: stored, nameFingerprint: fpOf(name), createdAt: now })
      .onConflictDoNothing({ target: tags.nameFingerprint });
  }
  // 平文タグ名 → id を引けるよう fingerprint で突き合わせる。今回必要な
  // fingerprint だけを IN 句で引き、tags 全件スキャンを避ける（増分解析での負荷対策）
  const fingerprints = [...names].map(fpOf);
  const idByFingerprint = new Map<string, number>();
  for (const fps of batched(fingerprints, 200)) {
    const rows = await tx
      .select({ id: tags.id, nameFingerprint: tags.nameFingerprint })
      .from(tags)
      .where(inArray(tags.nameFingerprint, fps));
    for (const row of rows) idByFingerprint.set(row.nameFingerprint, row.id);
  }
  return new Map([...names].map((name) => [name, idByFingerprint.get(fpOf(name))]));
}

/**
 * planWrites の出力をトランザクション 1 つで機械的に適用する
 * （全量・増分で共通の書き込み面。トランザクション境界はここが握る）。
 * DbError への写像は呼び出し側（解析サービス）の tryDbAsync 境界で行う。
 */
export async function applyAnalysisPlan(db: Db, plan: WritePlan, now: string): Promise<void> {
  const crypto = getCrypto(db);
  await db.transaction(async (tx) => {
    // タグ: 変わったチャンクだけ delete → insert（削除チャンク分は FK cascade 済み）。
    const idByName = await ensureTagIds(tx, crypto, plan.tagNames, now);
    for (const { chunkId, tags: tagList } of plan.tagRewrites) {
      await tx.delete(chunkTags).where(eq(chunkTags.chunkId, chunkId));
      for (const tag of tagList) {
        const tagId = idByName.get(tag.name);
        if (tagId !== undefined) {
          await tx.insert(chunkTags).values({ chunkId, tagId, score: tag.score });
        }
      }
    }
    // どのチャンクにも付かなくなったタグは削除する（乱立防止）
    await tx.run(sql`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM chunk_tags)`);

    // リンク: 全量は全 auto を張り替え、増分は対象チャンクが関与する auto だけ張り替える。
    if (plan.relinkChunkIds === "all") {
      await tx.delete(links).where(eq(links.origin, "auto"));
    } else {
      for (const ids of batched(plan.relinkChunkIds, 200)) {
        await tx
          .delete(links)
          .where(
            and(
              eq(links.origin, "auto"),
              or(inArray(links.fromChunkId, ids), inArray(links.toChunkId, ids)),
            ),
          );
      }
    }
    for (const link of plan.insertLinks) {
      await tx
        .insert(links)
        .values({ ...link, origin: "auto" })
        .onConflictDoNothing();
    }

    // 極性: bump するチャンクは updatedAt も進める（差分取得が変更ノードを拾えるように）。
    for (const { chunkId, polarity, bump } of plan.polarityWrites) {
      const set = bump ? { polarity, updatedAt: now } : { polarity };
      await tx.update(chunks).set(set).where(eq(chunks.id, chunkId));
    }
  });
}

/** タグ統合の提案（backend/analysis の proposeTagMerges が算出。適用時は from/to のみ使う） */
export interface MergeProposal {
  /** 統合されて消えるタグ */
  from: string;
  /** 統合先（代表）タグ */
  to: string;
  reason: "edit-distance" | "embedding";
}

/** 提案を適用する: chunk_tags を代表タグへ付け替え、空になったタグを消す */
export function applyTagMerges(
  db: Db,
  proposals: MergeProposal[],
): ResultAsync<{ merged: number }, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.select().from(tags);
      // proposals は平文タグ名。暗号 ON では r.name が暗号文なので、平文名 → id は
      // fingerprint（= ブラインドインデックス）で突き合わせる。OFF は fingerprint=平文名。
      const idByName = new Map(
        rows.map((r) => [crypto === undefined ? r.name : r.nameFingerprint, r.id]),
      );
      const keyOf = (name: string) => (crypto === undefined ? name : crypto.fingerprint(name));
      for (const proposal of proposals) {
        const fromId = idByName.get(keyOf(proposal.from));
        const toId = idByName.get(keyOf(proposal.to));
        if (fromId === undefined || toId === undefined) continue;
        const existing = new Set(
          (await tx.select().from(chunkTags).where(eq(chunkTags.tagId, toId))).map(
            (r) => r.chunkId,
          ),
        );
        for (const row of await tx.select().from(chunkTags).where(eq(chunkTags.tagId, fromId))) {
          if (!existing.has(row.chunkId)) {
            await tx
              .insert(chunkTags)
              .values({ chunkId: row.chunkId, tagId: toId, score: row.score });
          }
        }
        await tx.delete(chunkTags).where(eq(chunkTags.tagId, fromId));
        await tx.delete(tags).where(eq(tags.id, fromId));
      }
    });
    return { merged: proposals.length };
  });
}
