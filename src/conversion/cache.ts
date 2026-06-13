import type { Result } from "neverthrow";
import type { Db } from "@/db/client.ts";
import type { DbError } from "@/db/error.ts";
import { tryDb } from "@/db/error.ts";
import { conversionCache } from "@/db/schema.ts";

/** 永続化済みのかな→確定変換キャッシュをすべて読む。起動時に 1 回 */
export function loadConversionCache(db: Db): Result<Map<string, string>, DbError> {
  return tryDb(() => {
    const rows = db.select().from(conversionCache).all();
    return new Map(rows.map((r) => [r.kana, r.converted]));
  });
}

/** エンジンの変換結果を 1 件キャッシュする（自動保存と同じく冪等な upsert） */
export function saveConversion(
  db: Db,
  kana: string,
  converted: string,
  now: string = new Date().toISOString(),
): Result<void, DbError> {
  return tryDb(() => {
    db.insert(conversionCache)
      .values({ kana, converted, updatedAt: now })
      .onConflictDoUpdate({
        target: conversionCache.kana,
        set: { converted, updatedAt: now },
      })
      .run();
  });
}
