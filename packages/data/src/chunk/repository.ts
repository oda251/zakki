import { and, asc, eq, gte, isNotNull } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { Chunk } from "@zakki/data/db/schema.ts";
import { chunks } from "@zakki/data/db/schema.ts";

/**
 * 統合チャンクモデル（docs/CHUNKS.md）のリポジトリ。
 * ツリーの不変条件はここに封じる:
 * - トップレベル（parent_id NULL）は日付チャンクのみ（date 非 NULL・1 日 1 件）
 * - 子は (parent_id, position) を安定キーとして決定的チャンク化の結果を upsert する
 * - 暗号 ON では content を暗号化する。ただし日付チャンクの content は date と
 *   同値の平文（date が平文である方針の帰結）
 */

/** 暗号 ON なら復号して平文 Chunk を返す。日付チャンク（date 非 NULL）は平文のまま */
function decChunk(crypto: CryptoContext | undefined, c: Chunk): Chunk {
  if (crypto === undefined || c.date !== null) return c;
  return { ...c, content: crypto.decString(c.content, "chunk.content") };
}

function encContent(crypto: CryptoContext | undefined, content: string): string {
  return crypto === undefined ? content : crypto.encString(content, "chunk.content");
}

export interface ChunkDraftInput {
  content: string;
}

/** 日付チャンク（トップレベル・1 日 1 件）を読む。無ければ null */
export function getDateChunk(db: Db, date: string): ResultAsync<Chunk | null, DbError> {
  return tryDbAsync(async () => {
    const [existing] = await db.select().from(chunks).where(eq(chunks.date, date)).limit(1);
    return existing ?? null;
  });
}

/** 当日（または指定日）の日付チャンクを取得・なければ作成する。冪等 */
export function getOrCreateDateChunk(
  db: Db,
  date: string,
  now: string = new Date().toISOString(),
): ResultAsync<Chunk, DbError> {
  return getDateChunk(db, date).andThen((existing) =>
    tryDbAsync(async () => {
      if (existing !== null) return existing;
      const [created] = await db
        .insert(chunks)
        .values({
          parentId: null,
          position: 0,
          content: date,
          date,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (created === undefined) {
        throw new Error("日付チャンクの作成に失敗しました");
      }
      return created;
    }),
  );
}

/** id 指定でチャンクを読む（復号済み）。無ければ null */
export function getChunk(db: Db, id: number): ResultAsync<Chunk | null, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const [row] = await db.select().from(chunks).where(eq(chunks.id, id)).limit(1);
    return row === undefined ? null : decChunk(crypto, row);
  });
}

/** 親バッファの子チャンクを position 順に読む（復号済み） */
export function listChildren(db: Db, parentId: number): ResultAsync<Chunk[], DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const rows = await db
      .select()
      .from(chunks)
      .where(eq(chunks.parentId, parentId))
      .orderBy(asc(chunks.position));
    return rows.map((c) => decChunk(crypto, c));
  });
}

/** 全日付チャンク（date 昇順） */
export function listDateChunks(db: Db): ResultAsync<Chunk[], DbError> {
  return tryDbAsync(() =>
    db.select().from(chunks).where(isNotNull(chunks.date)).orderBy(asc(chunks.date)),
  );
}

/**
 * 親バッファの自動保存の永続化単位。決定的チャンク化の結果を
 * (parent_id, position) ベースで upsert + 余剰削除する（1 トランザクション）。
 * キーストローク単位で呼ばれても冪等。余剰 position の削除は、その行が
 * 子を持つ場合も子孫ごと cascade で消す（docs/CHUNKS.md の投影の破壊性）。
 */
export function saveChildren(
  db: Db,
  parentId: number,
  drafts: readonly ChunkDraftInput[],
  now: string = new Date().toISOString(),
): ResultAsync<Chunk[], DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(() =>
    db.transaction(async (tx) => {
      const saved: Chunk[] = [];
      for (const [position, draft] of drafts.entries()) {
        const encContentValue = encContent(crypto, draft.content);
        const [row] = await tx
          .insert(chunks)
          .values({
            parentId,
            position,
            content: encContentValue,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [chunks.parentId, chunks.position],
            set: { content: encContentValue, updatedAt: now },
          })
          .returning();
        if (row === undefined) {
          throw new Error("chunk の保存に失敗しました");
        }
        saved.push(decChunk(crypto, row));
      }
      await tx
        .delete(chunks)
        .where(and(eq(chunks.parentId, parentId), gte(chunks.position, drafts.length)));
      return saved;
    }),
  );
}

/**
 * チャンク本文を id 指定で書き換える（詳細ペインの過去チャンク編集用）。
 * 日付チャンク（date 非 NULL）は書き換えない（content = date の不変条件を守る）。
 */
export function updateChunkContent(
  db: Db,
  id: number,
  content: string,
  now: string = new Date().toISOString(),
): ResultAsync<void, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const [row] = await db.select().from(chunks).where(eq(chunks.id, id)).limit(1);
    if (row === undefined) {
      throw new Error(`チャンクが存在しません: id=${id}`);
    }
    if (row.date !== null) {
      throw new Error("日付チャンクの content は書き換えられません");
    }
    await db
      .update(chunks)
      .set({ content: encContent(crypto, content), updatedAt: now })
      .where(eq(chunks.id, id));
  });
}

/** チャンクを削除する。子孫・タグ・リンク・埋め込みは FK cascade で連鎖削除 */
export function deleteChunk(db: Db, id: number): ResultAsync<void, DbError> {
  return tryDbAsync(async () => {
    await db.delete(chunks).where(eq(chunks.id, id));
  });
}
