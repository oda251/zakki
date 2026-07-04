import { eq } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { corrections } from "@zakki/data/db/schema.ts";

/** 学習済みの手動修正（かな → 確定表記）をすべて読む。起動時に 1 回 */
export function loadCorrections(db: Db): ResultAsync<Map<string, string>, DbError> {
  return tryDbAsync(async () => {
    const rows = await db.select().from(corrections);
    return new Map(rows.map((r) => [r.kana, r.chosen]));
  });
}

export function saveCorrection(
  db: Db,
  kana: string,
  chosen: string,
  now: string = new Date().toISOString(),
): ResultAsync<void, DbError> {
  return tryDbAsync(async () => {
    await db
      .insert(corrections)
      .values({ kana, chosen, updatedAt: now })
      .onConflictDoUpdate({
        target: corrections.kana,
        set: { chosen, updatedAt: now },
      });
  });
}

export function deleteCorrection(db: Db, kana: string): ResultAsync<void, DbError> {
  return tryDbAsync(async () => {
    await db.delete(corrections).where(eq(corrections.kana, kana));
  });
}
