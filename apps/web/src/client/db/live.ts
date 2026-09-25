/**
 * RxDB Observable を UI 購読用の reactive view に変換する（Phase 4, #40 / #44）。
 */
import { map } from "rxjs";
import type { Observable } from "rxjs";
import type {
  ChunkDoc,
  ChunkUserTagDoc,
  FileDoc,
  LinkDoc,
  ZakkiDatabase,
} from "@zakki/web/client/db/database.ts";
import {
  byPosition,
  toChunkDoc,
  toFileDoc,
  toLinkDoc,
  toUserTagDoc,
} from "@zakki/web/client/db/docs.ts";

/** 全チャンクを流す reactive view（グラフ導出の入力） */
export function chunksView(db: ZakkiDatabase): Observable<ChunkDoc[]> {
  return db.chunks.find().$.pipe(map((docs) => docs.map(toChunkDoc)));
}

/** 全ユーザタグを流す reactive view（グラフ導出の入力） */
export function userTagsView(db: ZakkiDatabase): Observable<ChunkUserTagDoc[]> {
  return db.chunkUserTags.find().$.pipe(map((docs) => docs.map(toUserTagDoc)));
}

export function filesView(db: ZakkiDatabase): Observable<FileDoc[]> {
  return db.files.find().$.pipe(map((docs) => docs.map(toFileDoc)));
}

/** 全リンクを流す reactive view（グラフエッジ導出の入力, #77） */
export function linksView(db: ZakkiDatabase): Observable<LinkDoc[]> {
  return db.links.find().$.pipe(map((docs) => docs.map(toLinkDoc)));
}

/** 当該 parentId の子を position 昇順で流す reactive view */
export function childrenView(db: ZakkiDatabase, parentId: string): Observable<ChunkDoc[]> {
  return db.chunks
    .find({ selector: { parentId } })
    .$.pipe(map((docs) => docs.map(toChunkDoc).toSorted(byPosition)));
}
