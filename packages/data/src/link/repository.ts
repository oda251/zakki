import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { links } from "@zakki/data/db/schema.ts";

/**
 * ユーザ操作由来の手動リンク（web の数珠繋ぎ自動リンク等）を張る。
 * links の不変条件（双方向とみなし from < to で正規化）に合わせ、既存ペアは
 * no-op（auto を上書きしない）。自己リンクは張らない。score=1（明示的関連）。
 * analyzeAll は origin="auto" のみ張り替えるため、manual リンクは解析後も残る。
 */
export function addManualLink(db: Db, a: number, b: number): ResultAsync<void, DbError> {
  return tryDbAsync(async () => {
    if (a === b) return;
    const [from, to] = a < b ? [a, b] : [b, a];
    await db
      .insert(links)
      .values({ fromChunkId: from, toChunkId: to, score: 1, origin: "manual" })
      .onConflictDoNothing();
  });
}
