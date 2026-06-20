import { and, asc, eq, gte } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { Chunk, Entry } from "@zakki/data/db/schema.ts";
import { chunks, entries } from "@zakki/data/db/schema.ts";

export interface ChunkInput {
  content: string;
}

export interface EntrySnapshot {
  /** ローカル日付 YYYY-MM-DD */
  date: string;
  raw: string;
  converted: string;
  chunks: ChunkInput[];
}

export interface SavedEntry {
  entry: Entry;
  chunks: Chunk[];
}

export function getOrCreateEntry(
  db: Db,
  date: string,
  now: string = new Date().toISOString(),
): ResultAsync<Entry, DbError> {
  return tryDbAsync(async () => {
    const [existing] = await db.select().from(entries).where(eq(entries.date, date)).limit(1);
    if (existing !== undefined) {
      return existing;
    }
    const [created] = await db
      .insert(entries)
      .values({ date, createdAt: now, updatedAt: now })
      .returning();
    if (created === undefined) {
      throw new Error("entry の作成に失敗しました");
    }
    return created;
  });
}

/**
 * 自動保存の永続化単位。エントリ本文の upsert と、決定的チャンク化の結果の
 * (entry_id, position) ベース upsert + 余剰削除を 1 トランザクションで行う。
 * キーストローク単位で呼ばれても冪等。
 */
export function saveSnapshot(
  db: Db,
  snapshot: EntrySnapshot,
  now: string = new Date().toISOString(),
): ResultAsync<SavedEntry, DbError> {
  return tryDbAsync(() =>
    db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({
          date: snapshot.date,
          raw: snapshot.raw,
          converted: snapshot.converted,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: entries.date,
          set: { raw: snapshot.raw, converted: snapshot.converted, updatedAt: now },
        })
        .returning();
      if (entry === undefined) {
        throw new Error("entry の保存に失敗しました");
      }

      const saved: Chunk[] = [];
      for (const [position, chunk] of snapshot.chunks.entries()) {
        const [row] = await tx
          .insert(chunks)
          .values({
            entryId: entry.id,
            position,
            content: chunk.content,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [chunks.entryId, chunks.position],
            set: { content: chunk.content, updatedAt: now },
          })
          .returning();
        if (row === undefined) {
          throw new Error("chunk の保存に失敗しました");
        }
        saved.push(row);
      }

      await tx
        .delete(chunks)
        .where(and(eq(chunks.entryId, entry.id), gte(chunks.position, snapshot.chunks.length)));

      return { entry, chunks: saved };
    }),
  );
}

export function getEntryWithChunks(db: Db, date: string): ResultAsync<SavedEntry | null, DbError> {
  return tryDbAsync(async () => {
    const [entry] = await db.select().from(entries).where(eq(entries.date, date)).limit(1);
    if (entry === undefined) {
      return null;
    }
    const list = await db
      .select()
      .from(chunks)
      .where(eq(chunks.entryId, entry.id))
      .orderBy(asc(chunks.position));
    return { entry, chunks: list };
  });
}
