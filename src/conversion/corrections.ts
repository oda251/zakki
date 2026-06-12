import { eq } from "drizzle-orm";
import type { Result } from "neverthrow";
import type { Db } from "@/db/client.ts";
import type { DbError } from "@/db/error.ts";
import { tryDb } from "@/db/error.ts";
import { corrections } from "@/db/schema.ts";

/** 学習済みの手動修正（かな → 確定表記）をすべて読む。起動時に 1 回 */
export function loadCorrections(db: Db): Result<Map<string, string>, DbError> {
  return tryDb(() => {
    const rows = db.select().from(corrections).all();
    return new Map(rows.map((r) => [r.kana, r.chosen]));
  });
}

export function saveCorrection(
  db: Db,
  kana: string,
  chosen: string,
  now: string = new Date().toISOString(),
): Result<void, DbError> {
  return tryDb(() => {
    db.insert(corrections)
      .values({ kana, chosen, updatedAt: now })
      .onConflictDoUpdate({
        target: corrections.kana,
        set: { chosen, updatedAt: now },
      })
      .run();
  });
}

export function deleteCorrection(db: Db, kana: string): Result<void, DbError> {
  return tryDb(() => {
    db.delete(corrections).where(eq(corrections.kana, kana)).run();
  });
}
