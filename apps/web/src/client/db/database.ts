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
import type { RxCollection, RxConflictHandler, RxDatabase, RxJsonSchema, RxStorage } from "rxdb";
import type {
  Chunk,
  ChunkUserTag,
  Correction,
  Link,
  Tag,
  ZakkiFile,
} from "@zakki/web/shared/api-types.ts";

/**
 * RxDB は string primaryKey 必須。サーバ数値 id を文字列化して持つ。
 * updatedAt は replication の checkpoint / 衝突判定に必須のため、サーバ表に
 * 無い tags / chunkUserTags もクライアント doc では持つ（wire にそのまま載る）。
 *
 * fileId は {@link FileDoc} の string id への参照なので、サーバの数値 id を
 * 文字列に読み替える（blob チャンク ⇄ files doc の対応は replication wire 上で
 * クライアント側の doc 同士で成立する。サーバの chunks.file_id と files.id は
 * 数値だが、クライアントはどちらも string で持つ）。
 */
export type ChunkDoc = {
  id: string;
  parentId: string | null;
  fileId: string | null;
} & Omit<Chunk, "id" | "parentId" | "createdAt" | "fileId">;
export type ChunkUserTagDoc = { id: string; chunkId: string; updatedAt: string } & Pick<
  ChunkUserTag,
  "name"
>;
export type TagDoc = { id: string; updatedAt: string } & Pick<Tag, "name">;
export type CorrectionDoc = Correction;
/**
 * アップロードファイル（issue #157）のメタデータ doc。実体（バイト列）はサーバ側
 * (R2) にあり、objectKey がその所在。encryption は「クライアントの FEK（#157 §5）
 * で part を暗号化したか」のフラグで、file の name 自体はチャンク正文と同じく
 * DEK（chunk の E2E）で暗号化される（modifiers.ts の filePush）。
 */
export type FileDoc = { id: string } & Omit<ZakkiFile, "id" | "createdAt">;
/**
 * chunk 間リンク（数珠繋ぎ・意味リンク, #77）。サーバ links 表と同じく
 * from < to 正規化のペア一意で、id はペアから決定的に導出する（ids.ts の
 * {@link import("@zakki/web/client/db/ids.ts").linkDocId}）。
 */
export type LinkDoc = {
  id: string;
  fromChunkId: string;
  toChunkId: string;
  updatedAt: string;
} & Pick<Link, "score" | "origin">;

export type ZakkiCollections = {
  chunks: RxCollection<ChunkDoc>;
  chunkUserTags: RxCollection<ChunkUserTagDoc>;
  tags: RxCollection<TagDoc>;
  links: RxCollection<LinkDoc>;
  corrections: RxCollection<CorrectionDoc>;
  files: RxCollection<FileDoc>;
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
    // 既存 doc（kind/fileId を書かない insert）を無傷で移行するため default で補う:
    // テキスト草稿は kind="text"・fileId=null、blob は kind="blob"・fileId=<files.id>
    kind: { type: "string", enum: ["text", "blob"], default: "text" },
    fileId: { type: ["string", "null"], default: null },
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

const linksSchema = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    // chunk id（maxLength 32）2 つを "-" で結ぶため 65
    id: { type: "string", maxLength: 65 },
    fromChunkId: { type: "string" },
    toChunkId: { type: "string" },
    score: { type: "number" },
    origin: { type: "string", enum: ["auto", "manual"] },
    updatedAt: { type: "string" },
  },
  required: ["id", "fromChunkId", "toChunkId", "score", "origin", "updatedAt"],
} as const satisfies RxJsonSchema<LinkDoc>;

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

const filesSchema = {
  version: 0,
  primaryKey: "id",
  type: "object",
  properties: {
    // サーバ files.id は整数 autoincrement だが、クライアント採番（ids.ts の
    // newDocId, ~1.7e15 < Number.MAX_SAFE_INTEGER）を string で持つ
    id: { type: "string", maxLength: 32 },
    name: { type: "string" },
    extension: { type: "string" },
    encryption: { type: "string", enum: ["none", "password"] },
    objectKey: { type: "string" },
    size: { type: "number" },
    partSize: { type: "number" },
    updatedAt: { type: "string" },
  },
  required: ["id", "name", "extension", "encryption", "objectKey", "size", "partSize", "updatedAt"],
} as const satisfies RxJsonSchema<FileDoc>;

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
    links: { schema: linksSchema, conflictHandler: serverWinsConflictHandler<LinkDoc>() },
    corrections: {
      schema: correctionsSchema,
      conflictHandler: serverWinsConflictHandler<CorrectionDoc>(),
    },
    files: { schema: filesSchema, conflictHandler: serverWinsConflictHandler<FileDoc>() },
  });
  return db;
}
