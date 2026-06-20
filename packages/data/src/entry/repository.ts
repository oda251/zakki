import { and, asc, eq, gte } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { Chunk, Entry } from "@zakki/data/db/schema.ts";
import { chunks, entries } from "@zakki/data/db/schema.ts";

/** 暗号 ON なら復号して平文 Entry を返す。OFF はそのまま */
function decEntry(crypto: CryptoContext | undefined, e: Entry): Entry {
  if (crypto === undefined) return e;
  return {
    ...e,
    raw: crypto.decString(e.raw, "entry.raw"),
    converted: crypto.decString(e.converted, "entry.converted"),
  };
}

/** 暗号 ON なら復号して平文 Chunk を返す。OFF はそのまま */
function decChunk(crypto: CryptoContext | undefined, c: Chunk): Chunk {
  if (crypto === undefined) return c;
  return { ...c, content: crypto.decString(c.content, "chunk.content") };
}

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
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const [existing] = await db.select().from(entries).where(eq(entries.date, date)).limit(1);
    if (existing !== undefined) {
      return decEntry(crypto, existing);
    }
    // 新規 entry は raw/converted とも空文字。暗号 ON でも空文字を暗号化して
    // 格納し、読み出し時に復号して "" に戻す（空でも at-rest を平文にしない）。
    const empty = crypto === undefined ? "" : crypto.encString("", "entry.raw");
    const emptyConv = crypto === undefined ? "" : crypto.encString("", "entry.converted");
    const [created] = await db
      .insert(entries)
      .values({ date, raw: empty, converted: emptyConv, createdAt: now, updatedAt: now })
      .returning();
    if (created === undefined) {
      throw new Error("entry の作成に失敗しました");
    }
    return decEntry(crypto, created);
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
  const crypto = getCrypto(db);
  // 暗号 ON は書き込み前に平文を暗号化し、戻り値は復号して平文の SavedEntry を返す
  // （呼び出し側は暗号の有無を意識しない）。OFF は素通しで従来と同一。
  const encRaw = crypto === undefined ? snapshot.raw : crypto.encString(snapshot.raw, "entry.raw");
  const encConverted =
    crypto === undefined
      ? snapshot.converted
      : crypto.encString(snapshot.converted, "entry.converted");
  return tryDbAsync(() =>
    db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(entries)
        .values({
          date: snapshot.date,
          raw: encRaw,
          converted: encConverted,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: entries.date,
          set: { raw: encRaw, converted: encConverted, updatedAt: now },
        })
        .returning();
      if (entry === undefined) {
        throw new Error("entry の保存に失敗しました");
      }

      const saved: Chunk[] = [];
      for (const [position, chunk] of snapshot.chunks.entries()) {
        const encContent =
          crypto === undefined ? chunk.content : crypto.encString(chunk.content, "chunk.content");
        const [row] = await tx
          .insert(chunks)
          .values({
            entryId: entry.id,
            position,
            content: encContent,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [chunks.entryId, chunks.position],
            set: { content: encContent, updatedAt: now },
          })
          .returning();
        if (row === undefined) {
          throw new Error("chunk の保存に失敗しました");
        }
        saved.push(decChunk(crypto, row));
      }

      await tx
        .delete(chunks)
        .where(and(eq(chunks.entryId, entry.id), gte(chunks.position, snapshot.chunks.length)));

      return { entry: decEntry(crypto, entry), chunks: saved };
    }),
  );
}

export function getEntryWithChunks(db: Db, date: string): ResultAsync<SavedEntry | null, DbError> {
  const crypto = getCrypto(db);
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
    return { entry: decEntry(crypto, entry), chunks: list.map((c) => decChunk(crypto, c)) };
  });
}
