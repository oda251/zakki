import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { links } from "@zakki/data/db/schema.ts";

/**
 * ユーザ操作由来の手動リンク（web の数珠繋ぎ自動リンク等）をまとめて張る。
 * links の不変条件（双方向とみなし from < to で正規化）に合わせ、既存ペアは
 * no-op（auto を上書きしない）。自己リンクは張らない。score=1（明示的関連）。
 * analyzeAll は origin="auto" のみ張り替えるため、manual リンクは解析後も残る。
 * 数珠繋ぎの一括作成を 1 insert で終えるためのバッチ形（RTT・文の数を減らす）。
 */
export function addManualLinks(
  db: Db,
  pairs: readonly { from: number; to: number }[],
): ResultAsync<void, DbError> {
  return tryDbAsync(async () => {
    const seen = new Set<string>();
    const values = [];
    for (const pair of pairs) {
      if (pair.from === pair.to) continue;
      const [from, to] = pair.from < pair.to ? [pair.from, pair.to] : [pair.to, pair.from];
      const key = `${from}-${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push({ fromChunkId: from, toChunkId: to, score: 1, origin: "manual" as const });
    }
    if (values.length === 0) return;
    await db.insert(links).values(values).onConflictDoNothing();
  });
}

/** 単一ペア版（既存呼び出し互換）。実体は {@link addManualLinks} */
export function addManualLink(db: Db, a: number, b: number): ResultAsync<void, DbError> {
  return addManualLinks(db, [{ from: a, to: b }]);
}
