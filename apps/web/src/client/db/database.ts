/**
 * クライアント側 RxDB データベース定義（Phase 1, #40）。
 *
 * doc 型はサーバ SSOT（drizzle スキーマ, `@zakki/data/db/schema.ts`）由来。
 * RxDB は primaryKey に string を要求するため、サーバの数値 id / 参照は
 * ここで string に上書きする（type-only import なので client バンドルに
 * drizzle は載らない）。
 *
 * storage は呼び出し側が用意する（DI）。本番コードは dev-mode / ajv /
 * memory-storage を import しない — それらはテスト側の責務。
 */
import { createRxDatabase } from "rxdb";
import type {
  RxCollection,
  RxConflictHandler,
  RxDatabase,
  RxDocument,
  RxJsonSchema,
  RxStorage,
} from "rxdb";
import type { Chunk, ChunkUserTag, Correction, Tag } from "@zakki/web/shared/api-types.ts";

/**
 * RxDB は string primaryKey 必須。サーバ数値 id を文字列化して持つ。
 * updatedAt は replication の checkpoint / 衝突判定に必須のため、サーバ表に
 * 無い tags / chunkUserTags もクライアント doc では持つ（wire にそのまま載る）。
 */
export type ChunkDoc = { id: string; parentId: string | null } & Omit<
  Chunk,
  "id" | "parentId" | "createdAt"
>;
export type ChunkUserTagDoc = { id: string; chunkId: string; updatedAt: string } & Pick<
  ChunkUserTag,
  "name"
>;
export type TagDoc = { id: string; updatedAt: string } & Pick<Tag, "name">;
export type CorrectionDoc = Correction;

export type ZakkiCollections = {
  chunks: RxCollection<ChunkDoc>;
  chunkUserTags: RxCollection<ChunkUserTagDoc>;
  tags: RxCollection<TagDoc>;
  corrections: RxCollection<CorrectionDoc>;
};
export type ZakkiDatabase = RxDatabase<ZakkiCollections>;

const chunksSchema = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 32 },
    parentId: { type: ["string", "null"] },
    position: { type: "number" },
    content: { type: "string" },
    date: { type: ["string", "null"] },
    polarity: { type: ["number", "null"] },
    updatedAt: { type: "string" },
  },
  required: ["id", "position", "content", "updatedAt"],
} as const satisfies RxJsonSchema<ChunkDoc>;

const chunkUserTagsSchema = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 32 },
    chunkId: { type: "string" },
    name: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "chunkId", "name", "updatedAt"],
} as const satisfies RxJsonSchema<ChunkUserTagDoc>;

const tagsSchema = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 32 },
    name: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "name", "updatedAt"],
} as const satisfies RxJsonSchema<TagDoc>;

const correctionsSchema = {
  version: 0,
  primaryKey: "kana",
  type: "object",
  properties: {
    kana: { type: "string", maxLength: 128 },
    chosen: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["kana", "chosen", "updatedAt"],
} as const satisfies RxJsonSchema<CorrectionDoc>;

/**
 * DB-per-user 前提の単純衝突方針（#43）: (updatedAt, _deleted) の一致で同一視し、
 * 差異はサーバ（realMasterState）を常に採る。deepEqual を避けた軽量版。
 */
function serverWinsConflictHandler<T extends { updatedAt: string }>(): RxConflictHandler<T> {
  return {
    isEqual: (a, b) => a.updatedAt === b.updatedAt && a._deleted === b._deleted,
    resolve: (input) => Promise.resolve(input.realMasterState),
  };
}

/** name は既定 "zakki"。テスト・複数インスタンス検証では別名を渡して分離する */
export async function createZakkiDb(
  storage: RxStorage<unknown, unknown>,
  name = "zakki",
): Promise<ZakkiDatabase> {
  const db = await createRxDatabase<ZakkiCollections>({ name, storage });
  await db.addCollections({
    chunks: { schema: chunksSchema, conflictHandler: serverWinsConflictHandler<ChunkDoc>() },
    chunkUserTags: {
      schema: chunkUserTagsSchema,
      conflictHandler: serverWinsConflictHandler<ChunkUserTagDoc>(),
    },
    tags: { schema: tagsSchema, conflictHandler: serverWinsConflictHandler<TagDoc>() },
    corrections: {
      schema: correctionsSchema,
      conflictHandler: serverWinsConflictHandler<CorrectionDoc>(),
    },
  });
  return db;
}

/** RxDocument<ChunkDoc> → ChunkDoc への field コピー（プレーンオブジェクト化） */
export function toChunkDoc(d: RxDocument<ChunkDoc>): ChunkDoc {
  const json = d.toJSON();
  return {
    id: json.id,
    parentId: json.parentId,
    position: json.position,
    content: json.content,
    date: json.date,
    polarity: json.polarity,
    updatedAt: json.updatedAt,
  };
}

/** position 昇順の比較関数 */
export const byPosition = (a: ChunkDoc, b: ChunkDoc): number => a.position - b.position;

/** 当該 parentId の子を position 昇順で返す（RxDB sort/index を避け JS ソート） */
export async function childrenQuery(db: ZakkiDatabase, parentId: string): Promise<ChunkDoc[]> {
  const docs = await db.chunks.find({ selector: { parentId } }).exec();
  return docs.map(toChunkDoc).toSorted(byPosition);
}

/** kana→chosen の Map（変換シード） */
export async function correctionsMap(db: ZakkiDatabase): Promise<Map<string, string>> {
  const docs = await db.corrections.find().exec();
  return new Map(docs.map((d) => [d.kana, d.chosen]));
}
