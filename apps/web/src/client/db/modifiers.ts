/**
 * RxDB replication の push/pull modifier（Phase 2, #40）。
 *
 * クライアント doc とサーバ向け wire 表現の間で、暗号化フィールドの
 * enc/dec を行う純関数。副作用なし。
 *
 * 日付チャンク（`date !== null`）の content は AAD 束縛の対象外
 * （`schema.ts` の既存方針と同じく平文のまま同期する）。
 */
import type { ChunkDoc, ChunkUserTagDoc, TagDoc } from "@zakki/web/client/db/database.ts";
import type { FieldCrypto } from "@zakki/web/client/db/crypto.ts";

export type ChunkDocData = ChunkDoc & { _deleted: boolean };
export type ChunkUserTagDocData = ChunkUserTagDoc & { _deleted: boolean };
export type TagDocData = TagDoc & { _deleted: boolean };

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
  _deleted: boolean;
}

export interface TagWire {
  id: string;
  name: string;
  nameFingerprint: string;
  _deleted: boolean;
}

/** チャンク doc → wire。日付チャンクは content を暗号化しない */
export function chunkPush(fc: FieldCrypto, doc: ChunkDocData): ChunkWire {
  return {
    ...doc,
    content: doc.date === null ? fc.encString(doc.content, "chunk.content") : doc.content,
  };
}

/** チャンク wire → doc。日付チャンクは content を復号しない */
export function chunkPull(fc: FieldCrypto, wire: ChunkWire): ChunkDocData {
  return {
    ...wire,
    content: wire.date === null ? fc.decString(wire.content, "chunk.content") : wire.content,
  };
}

/** タグ doc → wire。name を暗号化し、決定的 fingerprint を付与する */
export function tagPush(fc: FieldCrypto, doc: TagDocData): TagWire {
  const { id, name, _deleted } = doc;
  return {
    id,
    name: fc.encString(name, "tag.name"),
    nameFingerprint: fc.fingerprint(name),
    _deleted,
  };
}

/** タグ wire → doc。nameFingerprint は doc に持たない */
export function tagPull(fc: FieldCrypto, wire: TagWire): TagDocData {
  const { id, name, _deleted } = wire;
  return {
    id,
    name: fc.decString(name, "tag.name"),
    _deleted,
  };
}

/** チャンクユーザタグ doc → wire。name を暗号化し、決定的 fingerprint を付与する */
export function userTagPush(fc: FieldCrypto, doc: ChunkUserTagDocData): ChunkUserTagWire {
  const { id, chunkId, name, _deleted } = doc;
  return {
    id,
    chunkId,
    name: fc.encString(name, "chunkUserTag.name"),
    nameFingerprint: fc.fingerprint(name),
    _deleted,
  };
}

/** チャンクユーザタグ wire → doc */
export function userTagPull(fc: FieldCrypto, wire: ChunkUserTagWire): ChunkUserTagDocData {
  const { id, chunkId, name, _deleted } = wire;
  return {
    id,
    chunkId,
    name: fc.decString(name, "chunkUserTag.name"),
    _deleted,
  };
}
