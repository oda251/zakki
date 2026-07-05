import { asc, eq } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunkUserTags } from "@zakki/data/db/schema.ts";

/**
 * チャンクへのユーザ明示タグ（旧セッションタグの一般化, docs/CHUNKS.md）。
 * 自動タグ（tags / chunk_tags）とは独立で、解析パスに影響しない。
 */

/** タグ名 → (name, fingerprint)。暗号 OFF は fingerprint = 平文名 */
function encTag(
  crypto: CryptoContext | undefined,
  name: string,
): { name: string; nameFingerprint: string } {
  if (crypto === undefined) return { name, nameFingerprint: name };
  return {
    name: crypto.encString(name, "chunkUserTag.name"),
    nameFingerprint: crypto.fingerprint(name),
  };
}

/** チャンクのユーザタグを全置換する（重複・空白のみは除去） */
export function setChunkUserTags(
  db: Db,
  chunkId: number,
  names: string[],
  now: string = new Date().toISOString(),
): ResultAsync<void, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(() =>
    db.transaction(async (tx) => {
      await tx.delete(chunkUserTags).where(eq(chunkUserTags.chunkId, chunkId));
      const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ""))];
      if (unique.length === 0) return;
      await tx
        .insert(chunkUserTags)
        .values(unique.map((name) => ({ chunkId, ...encTag(crypto, name), createdAt: now })));
    }),
  );
}

/** chunk id → ユーザタグ名（付与順） */
export function listUserTagsByChunk(db: Db): ResultAsync<Map<number, string[]>, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const rows = await db.select().from(chunkUserTags).orderBy(asc(chunkUserTags.id));
    const result = new Map<number, string[]>();
    for (const t of rows) {
      const name = crypto === undefined ? t.name : crypto.decString(t.name, "chunkUserTag.name");
      const list = result.get(t.chunkId) ?? [];
      list.push(name);
      result.set(t.chunkId, list);
    }
    return result;
  });
}
