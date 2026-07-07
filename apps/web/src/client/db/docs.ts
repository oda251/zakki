/**
 * RxDocument → プレーン doc の写像と一発読みクエリ（issue #44）。
 *
 * database.ts から分離しているのは import 重量のため: ここは rxdb を
 * 型でしか参照しないので、UI ストア（初期チャンク）から静的 import しても
 * rxdb 本体はバンドルに載らない（rxdb の実 import は bootstrap の
 * dynamic import 境界の内側だけ）。
 */
import type { RxDocument } from "rxdb";
import type { ChunkDoc, ChunkUserTagDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";

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

/** RxDocument<ChunkUserTagDoc> → ChunkUserTagDoc への field コピー */
export function toUserTagDoc(d: RxDocument<ChunkUserTagDoc>): ChunkUserTagDoc {
  const json = d.toJSON();
  return { id: json.id, chunkId: json.chunkId, name: json.name, updatedAt: json.updatedAt };
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
