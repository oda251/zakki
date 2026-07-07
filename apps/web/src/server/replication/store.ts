import { and, asc, eq, gt, or } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { replDocs } from "@zakki/data/db/schema.ts";
import type { Checkpoint, ReplDoc } from "@zakki/web/server/replication/protocol.ts";

/**
 * ReplicationStore（issue #42）: RxDB replication のサーバ側 dumb store。
 * 汎用テーブル `repl_docs` に collection ごとの wire doc（暗号文 JSON）を
 * domain schema 非依存で読み書きするだけで、中身は解釈しない（#28）。
 */

/** wire doc: id/updatedAt/_deleted は必須、それ以外のフィールドは passthrough */
export type WireDoc = ReplDoc & Record<string, unknown>;

/** value が wire doc として最低限の形を満たすか（自分が write した JSON の往復のみを想定） */
function isWireDoc(value: unknown): value is WireDoc {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || !("updatedAt" in value) || !("_deleted" in value)) return false;
  const { id, updatedAt, _deleted } = value;
  return typeof id === "string" && typeof updatedAt === "string" && typeof _deleted === "boolean";
}

function parseWireDoc(raw: string): WireDoc {
  const parsed: unknown = JSON.parse(raw);
  if (!isWireDoc(parsed)) {
    throw new Error("repl_docs.data が wire doc の形を満たしません");
  }
  return parsed;
}

export interface ReplicationStore {
  getById(collection: string, id: string): ResultAsync<WireDoc | undefined, DbError>;
  /**
   * cp より厳密に後（(updated_at, id) 昇順）の doc を最大 limit 件返す。
   * cp が null なら先頭から。tombstone（deleted）も含める（pull に流す）。
   */
  listChanges(
    collection: string,
    cp: Checkpoint | null,
    limit: number,
  ): ResultAsync<WireDoc[], DbError>;
  write(collection: string, doc: WireDoc): ResultAsync<void, DbError>;
}

/** libSQL(drizzle) 実装 */
export function createReplicationStore(db: Db): ReplicationStore {
  return {
    getById(collection, id) {
      return tryDbAsync(async () => {
        const [row] = await db
          .select()
          .from(replDocs)
          .where(and(eq(replDocs.collection, collection), eq(replDocs.id, id)))
          .limit(1);
        return row === undefined ? undefined : parseWireDoc(row.data);
      });
    },

    listChanges(collection, cp, limit) {
      // (updatedAt, id) の辞書式比較を SQL に写す（ISO 8601 文字列はバイト順 = 時系列順）。
      // 追いつき後の空 pull で collection 全件を転送・JSON.parse しないための絞り込み
      const inCollection = eq(replDocs.collection, collection);
      const afterCp =
        cp === null
          ? inCollection
          : and(
              inCollection,
              or(
                gt(replDocs.updatedAt, cp.updatedAt),
                and(eq(replDocs.updatedAt, cp.updatedAt), gt(replDocs.id, cp.id)),
              ),
            );
      return tryDbAsync(async () => {
        const rows = await db
          .select()
          .from(replDocs)
          .where(afterCp)
          .orderBy(asc(replDocs.updatedAt), asc(replDocs.id))
          .limit(limit);
        return rows.map((row) => parseWireDoc(row.data));
      });
    },

    write(collection, doc) {
      const { id, updatedAt, _deleted } = doc;
      return tryDbAsync(async () => {
        const data = JSON.stringify(doc);
        await db
          .insert(replDocs)
          .values({ collection, id, updatedAt, deleted: _deleted, data })
          .onConflictDoUpdate({
            target: [replDocs.collection, replDocs.id],
            set: { updatedAt, deleted: _deleted, data },
          });
      });
    },
  };
}
