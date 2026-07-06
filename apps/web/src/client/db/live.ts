/**
 * RxDB Observable を UI 購読用の reactive view に変換する（Phase 4, #40）。
 */
import { map } from "rxjs";
import type { Observable } from "rxjs";
import type { ChunkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { byPosition, toChunkDoc } from "@zakki/web/client/db/database.ts";

/** 当該 parentId の子を position 昇順で流す reactive view */
export function childrenView(db: ZakkiDatabase, parentId: string): Observable<ChunkDoc[]> {
  return db.chunks
    .find({ selector: { parentId } })
    .$.pipe(map((docs) => docs.map(toChunkDoc).toSorted(byPosition)));
}

/** kana→chosen の Map を流す reactive view（変換シード） */
export function correctionsView(db: ZakkiDatabase): Observable<Map<string, string>> {
  return db.corrections.find().$.pipe(map((docs) => new Map(docs.map((d) => [d.kana, d.chosen]))));
}
