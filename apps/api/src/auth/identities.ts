import { and, eq } from "drizzle-orm";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountIdentities } from "@zakki/api/db/schema.ts";

/**
 * アカウント表示用の主 identity（issue #159）。
 *
 * 「主は高々 1 つ」は部分一意インデックスが強制するが、「主が 0 件」は防げない
 * （DB の制約では表現できない）。主が居ない場合は最も古く作られた identity を
 * 主とみなして表示する。
 */
export interface DisplayIdentity {
  readonly providerId: string;
  readonly email: string | null;
  readonly createdAt: string;
}

/** account_identities の行を表示用の形へ直す */
function toDisplayIdentity(row: {
  provider: string;
  email: string | null;
  createdAt: string;
}): DisplayIdentity {
  return { providerId: row.provider, email: row.email, createdAt: row.createdAt };
}

/** アカウントの主 identity。無ければ最古の identity、identity が無ければ null */
export async function findPrimaryIdentity(
  db: ControlDb,
  accountId: string,
): Promise<DisplayIdentity | null> {
  const primary = await db
    .select()
    .from(accountIdentities)
    .where(and(eq(accountIdentities.accountId, accountId), eq(accountIdentities.isPrimary, 1)))
    .limit(1);
  if (primary[0] !== undefined) return toDisplayIdentity(primary[0]);

  const oldest = await db
    .select()
    .from(accountIdentities)
    .where(eq(accountIdentities.accountId, accountId))
    .orderBy(accountIdentities.createdAt)
    .limit(1);
  return oldest[0] === undefined ? null : toDisplayIdentity(oldest[0]);
}