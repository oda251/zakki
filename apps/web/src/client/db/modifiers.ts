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
import type { ChunkDoc, ChunkUserTagDoc, LinkDoc, TagDoc } from "@zakki/web/client/db/database.ts";
import type { FieldCrypto } from "@zakki/web/client/db/crypto.ts";

export type ChunkDocData = ChunkDoc & { _deleted: boolean };
export type ChunkUserTagDocData = ChunkUserTagDoc & { _deleted: boolean };
export type TagDocData = TagDoc & { _deleted: boolean };
export type LinkDocData = LinkDoc & { _deleted: boolean };

export interface ChunkWire {
  id: string;
  parentId: string | null;
  position: number;
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

/** チャンク doc → wire。日付チャンクは content を暗号化しない */
export function chunkPush(fc: FieldCrypto, doc: ChunkDocData): ChunkWire {
  return {
    ...doc,
    content: doc.date === null ? fc.encString(doc.content, AAD.chunkContent) : doc.content,
  };
}

/** チャンク wire → doc。日付チャンクは content を復号しない */
export function chunkPull(fc: FieldCrypto, wire: ChunkWire): ChunkDocData {
  return {
    ...wire,
    content: wire.date === null ? fc.decString(wire.content, AAD.chunkContent) : wire.content,
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
