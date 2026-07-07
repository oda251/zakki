import { and, eq } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { replDocs } from "@zakki/data/db/schema.ts";
import type { ReplDoc } from "@zakki/web/server/replication/protocol.ts";

/**
 * ReplicationStore（issue #42）: RxDB replication のサーバ側 dumb store。
 * 汎用テーブル `repl_docs` に collection ごとの wire doc（暗号文 JSON）を
 * domain schema 非依存で読み書きするだけで、中身は解釈しない（#28）。
 */

/**
 * wire doc: id/updatedAt/_deleted は必須、それ以外のフィールドは passthrough。
 *
 * domain 側の具体的な wire 型（{@link import("@zakki/web/client/db/modifiers.ts").ChunkWire} 等）は
 * TS の仕様上 `interface` ではなく `type`（オブジェクトリテラル型）で宣言する必要がある:
 * `interface` は明示的な index signature を持たない限り `Record<string, unknown>` と
 * 交差した型に代入できない（"Index signature ... is missing" エラー）。
 */
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
  listAll(collection: string): ResultAsync<WireDoc[], DbError>;
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

    listAll(collection) {
      return tryDbAsync(async () => {
        const rows = await db.select().from(replDocs).where(eq(replDocs.collection, collection));
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
