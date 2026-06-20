import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { conversionCache } from "@zakki/data/db/schema.ts";

/** 永続化済みのかな→確定変換キャッシュをすべて読む。起動時に 1 回 */
export function loadConversionCache(db: Db): ResultAsync<Map<string, string>, DbError> {
  return tryDbAsync(async () => {
    const rows = await db.select().from(conversionCache);
    return new Map(rows.map((r) => [r.kana, r.converted]));
  });
}

/** エンジンの変換結果を 1 件キャッシュする（自動保存と同じく冪等な upsert） */
export function saveConversion(
  db: Db,
  kana: string,
  converted: string,
  now: string = new Date().toISOString(),
): ResultAsync<void, DbError> {
  return tryDbAsync(async () => {
    await db
      .insert(conversionCache)
      .values({ kana, converted, updatedAt: now })
      .onConflictDoUpdate({
        target: conversionCache.kana,
        set: { converted, updatedAt: now },
      });
  });
}
