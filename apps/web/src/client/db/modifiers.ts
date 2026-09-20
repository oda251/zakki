/**
 * RxDB replication の push/pull modifier（Phase 2, #40）。
 *
 * クライアント doc とサーバ向け wire 表現の間で、暗号化フィールドの
 * enc/dec を行う純関数。副作用なし。
 *
 * 日付チャンク（`date !== null`）の content は AAD 束縛の対象外
 * （`schema.ts` の既存方針と同じく平文のまま同期する）。
 */
import { AAD } from "@zakki/core/crypto/aad.ts";
import type {
  ChunkDoc,
  ChunkUserTagDoc,
  FileDoc,
  LinkDoc,
  TagDoc,
} from "@zakki/web/client/db/database.ts";
import type { FieldCrypto } from "@zakki/web/client/db/crypto.ts";

export type ChunkDocData = ChunkDoc & { _deleted: boolean };
export type ChunkUserTagDocData = ChunkUserTagDoc & { _deleted: boolean };
export type TagDocData = TagDoc & { _deleted: boolean };
export type LinkDocData = LinkDoc & { _deleted: boolean };
export type FileDocData = FileDoc & { _deleted: boolean };

export interface ChunkWire {
  id: string;
  parentId: string | null;
  position: number;
  // blob チャンク（issue #157）は kind='blob'・fileId=<files.id> を wire で運ぶ
  kind: ChunkDoc["kind"];
  fileId: ChunkDoc["fileId"];
  content: string;
  date: string | null;
  polarity: number | null;
  updatedAt: string;
  _deleted: boolean;
}

export interface ChunkUserTagWire {
  id: string;
  chunkId: string;
  name: string;
  nameFingerprint: string;
  updatedAt: string;
  _deleted: boolean;
}

export interface TagWire {
  id: string;
  name: string;
  nameFingerprint: string;
  updatedAt: string;
  _deleted: boolean;
}

export interface LinkWire {
  id: string;
  fromChunkId: string;
  toChunkId: string;
  score: number;
  origin: LinkDoc["origin"];
  updatedAt: string;
  _deleted: boolean;
}

/** ファイル doc → wire（issue #157）。name のみ暗号化（filePush 参照） */
export interface FileWire {
  id: string;
  name: string;
  extension: string;
  encryption: FileDoc["encryption"];
  objectKey: string;
  size: number;
  partSize: number;
  updatedAt: string;
  _deleted: boolean;
}

/**
 * チャンク doc → wire。日付チャンクは content を暗号化しない。
 * kind / fileId（issue #157）は構造情報なので wire でも平文のまま運ぶ
 * （links が wire でも平文なのと同じ判断。id / parentId / position と同じ露出面）。
 */
export function chunkPush(fc: FieldCrypto, doc: ChunkDocData): ChunkWire {
  return {
    ...doc,
    content: doc.date === null ? fc.encString(doc.content, AAD.chunkContent) : doc.content,
  };
}

/** チャンク wire → doc。日付チャンクは content を復号しない。
 * kind / fileId は旧 wire（kind 導入前）との後方互換のため欠けていたら補う。 */
export function chunkPull(fc: FieldCrypto, wire: ChunkWire): ChunkDocData {
  return {
    ...wire,
    kind: wire.kind ?? "text",
    fileId: wire.fileId ?? null,
    content: wire.date === null ? fc.decString(wire.content, AAD.chunkContent) : wire.content,
  };
}

/**
 * ファイル doc → wire。name はチャンク正文と同じく DEK で暗号化する
 * （サーバは files.name を AAD.fileName で復号する, data/file/repository.ts の decFile）。
 * extension / size / partSize / objectKey は一覧表示の弁別に使うメタデータなので平文のまま。
 * この暗号化は doc.encryption（= FEK によるファイル本編の要否）とは無関係に走る:
 * filePush は DEK の有無だけで分岐する（chunkPush と同じ境界）。
 */
export function filePush(fc: FieldCrypto, doc: FileDocData): FileWire {
  return {
    ...doc,
    name: fc.encString(doc.name, AAD.fileName),
  };
}

/** ファイル wire → doc。name を復号する（{@link filePush} 参照） */
export function filePull(fc: FieldCrypto, wire: FileWire): FileDocData {
  return {
    ...wire,
    name: fc.decString(wire.name, AAD.fileName),
  };
}

/** タグ doc → wire。name を暗号化し、決定的 fingerprint を付与する */
export function tagPush(fc: FieldCrypto, doc: TagDocData): TagWire {
  const { id, name, updatedAt, _deleted } = doc;
  return {
    id,
    name: fc.encString(name, AAD.tagName),
    nameFingerprint: fc.fingerprint(name),
    updatedAt,
    _deleted,
  };
}

/** タグ wire → doc。nameFingerprint は doc に持たない */
export function tagPull(fc: FieldCrypto, wire: TagWire): TagDocData {
  const { id, name, updatedAt, _deleted } = wire;
  return {
    id,
    name: fc.decString(name, AAD.tagName),
    updatedAt,
    _deleted,
  };
}

/** チャンクユーザタグ doc → wire。name を暗号化し、決定的 fingerprint を付与する */
export function userTagPush(fc: FieldCrypto, doc: ChunkUserTagDocData): ChunkUserTagWire {
  const { id, chunkId, name, updatedAt, _deleted } = doc;
  return {
    id,
    chunkId,
    name: fc.encString(name, AAD.chunkUserTagName),
    nameFingerprint: fc.fingerprint(name),
    updatedAt,
    _deleted,
  };
}

/** チャンクユーザタグ wire → doc */
export function userTagPull(fc: FieldCrypto, wire: ChunkUserTagWire): ChunkUserTagDocData {
  const { id, chunkId, name, updatedAt, _deleted } = wire;
  return {
    id,
    chunkId,
    name: fc.decString(name, AAD.chunkUserTagName),
    updatedAt,
    _deleted,
  };
}

/**
 * リンク doc → wire（暗号化なし, #77）。リンクは構造情報（チャンク id ペア・
 * score・origin）のみで平文文字列を含まず、チャンク wire が id / parentId /
 * position を平文で持つのと同じ露出面に収まるため暗号化しない。タグの
 * blind index（fingerprint）は「name = ユーザの平文文字列」の等値検索用で、
 * リンクに相当物は無い（docs/CHUNKS.md §同期と E2E・#28 の暗号化対象は
 * content / name 系フィールドのみ）。
 */
export function linkPush(doc: LinkDocData): LinkWire {
  const { id, fromChunkId, toChunkId, score, origin, updatedAt, _deleted } = doc;
  return { id, fromChunkId, toChunkId, score, origin, updatedAt, _deleted };
}

/** リンク wire → doc（復号なし。{@link linkPush} 参照） */
export function linkPull(wire: LinkWire): LinkDocData {
  const { id, fromChunkId, toChunkId, score, origin, updatedAt, _deleted } = wire;
  return { id, fromChunkId, toChunkId, score, origin, updatedAt, _deleted };
}
