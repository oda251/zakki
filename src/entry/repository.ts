import { and, asc, eq, gte } from "drizzle-orm";
import type { Result } from "neverthrow";
import type { Db } from "@/db/client.ts";
import type { DbError } from "@/db/error.ts";
import { tryDb } from "@/db/error.ts";
import type { Chunk, Entry } from "@/db/schema.ts";
import { chunks, entries } from "@/db/schema.ts";

export interface ChunkInput {
  title: string;
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
): Result<Entry, DbError> {
  return tryDb(() => {
    const existing = db.select().from(entries).where(eq(entries.date, date)).get();
    if (existing !== undefined) {
      return existing;
    }
    return db.insert(entries).values({ date, createdAt: now, updatedAt: now }).returning().get();
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
): Result<SavedEntry, DbError> {
  return tryDb(() =>
    db.transaction((tx) => {
      const entry = tx
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
        .returning()
        .get();

      const saved = snapshot.chunks.map((chunk, position) =>
        tx
          .insert(chunks)
          .values({
            entryId: entry.id,
            position,
            title: chunk.title,
            content: chunk.content,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [chunks.entryId, chunks.position],
            set: { title: chunk.title, content: chunk.content, updatedAt: now },
          })
          .returning()
          .get(),
      );

      tx.delete(chunks)
        .where(and(eq(chunks.entryId, entry.id), gte(chunks.position, snapshot.chunks.length)))
        .run();

      return { entry, chunks: saved };
    }),
  );
}

export function getEntryWithChunks(db: Db, date: string): Result<SavedEntry | null, DbError> {
  return tryDb(() => {
    const entry = db.select().from(entries).where(eq(entries.date, date)).get();
    if (entry === undefined) {
      return null;
    }
    const list = db
      .select()
      .from(chunks)
      .where(eq(chunks.entryId, entry.id))
      .orderBy(asc(chunks.position))
      .all();
    return { entry, chunks: list };
  });
}
