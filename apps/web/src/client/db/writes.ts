/**
 * UI 書込みの RxDB 移行（issue #44）。
 *
 * サーバ REST（PUT /chunks/:id/children 等）に代わり、書込みはローカル RxDB
 * コレクションへ行う。replication（#43）が非同期にサーバへ反映するため、
 * ここでは wire・暗号を意識しない。意味論はサーバ実装
 * （`@zakki/data/chunk/repository.ts`）を踏襲する:
 * - saveChildrenDocs: content 突き合わせで既存 id を保ち、余りは position 順に
 *   再利用、どの草稿にも対応しない行は子孫（と userTags）ごと削除する
 * - 日付チャンクは content=date の平文・書き換え禁止
 *
 * サーバ実装との意図的な差分: 無変更行の updatedAt を書き換えない
 * （デバウンス保存のたびに全子チャンクが replication push されるのを防ぐ）。
 */
import type { ChunkDraft } from "@zakki/core/chunk/chunker.ts";
import type { ChunkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { byPosition, toChunkDoc } from "@zakki/web/client/db/docs.ts";
import { dateChunkId, newDocId } from "@zakki/web/client/db/ids.ts";

const nowIso = (): string => new Date().toISOString();

/**
 * 当日（または指定日）の日付チャンクを取得・なければ作成する。冪等。
 * id は日付から決定的に導出するため、多端末が同じ日に作成しても replication 後に
 * 同一 doc へ収束する（衝突は conflictHandler が解消する）。
 */
export async function getOrCreateDateChunkDoc(
  db: ZakkiDatabase,
  date: string,
  now: string = nowIso(),
): Promise<ChunkDoc> {
  const existing = await db.chunks.findOne({ selector: { date } }).exec();
  if (existing !== null) return toChunkDoc(existing);
  const doc = await db.chunks.insert({
    id: dateChunkId(date),
    parentId: null,
    position: 0,
    content: date,
    date,
    polarity: null,
    updatedAt: now,
  });
  return toChunkDoc(doc);
}

/** 対象 id 集合の部分木（自身を含む）を BFS で列挙する */
async function collectSubtree(db: ZakkiDatabase, rootIds: readonly string[]): Promise<string[]> {
  const all: string[] = [];
  let frontier = [...rootIds];
  while (frontier.length > 0) {
    all.push(...frontier);
    const children = await db.chunks.find({ selector: { parentId: { $in: frontier } } }).exec();
    frontier = children.map((d) => d.id);
  }
  return all;
}

async function removeSubtrees(db: ZakkiDatabase, rootIds: readonly string[]): Promise<void> {
  if (rootIds.length === 0) return;
  const ids = await collectSubtree(db, rootIds);
  await db.chunks.bulkRemove(ids);
  // サーバの FK cascade に相当: 消えたチャンクの userTags も落とす
  const tags = await db.chunkUserTags.find({ selector: { chunkId: { $in: ids } } }).exec();
  await db.chunkUserTags.bulkRemove(tags.map((t) => t.id));
}

/** チャンクを子孫・userTags ごと削除する（DELETE /chunks/:id 相当） */
export async function removeChunkTree(db: ZakkiDatabase, id: string): Promise<void> {
  await removeSubtrees(db, [id]);
}

/**
 * 親バッファの全子チャンクを草稿列で置き換える（PUT /chunks/:id/children 相当）。
 * 突き合わせ順序はサーバと同一: content 完全一致（同文は position 順に消費）→
 * 余った既存行を position 順に再利用（= 編集された行）→ 残りは削除。
 */
export async function saveChildrenDocs(
  db: ZakkiDatabase,
  parentId: string,
  drafts: readonly ChunkDraft[],
  now: string = nowIso(),
): Promise<ChunkDoc[]> {
  const existingDocs = await db.chunks.find({ selector: { parentId } }).exec();
  const existing = existingDocs.map(toChunkDoc).toSorted(byPosition);

  // 1. content 完全一致（同文が複数あれば position 順に消費）
  const queueByContent = new Map<string, ChunkDoc[]>();
  for (const c of existing) {
    const queue = queueByContent.get(c.content) ?? [];
    queue.push(c);
    queueByContent.set(c.content, queue);
  }
  const assigned: (ChunkDoc | undefined)[] = drafts.map((d) =>
    queueByContent.get(d.content)?.shift(),
  );

  // 2. 未対応の草稿 ← 未使用の既存行（position 順）＝編集された行
  const used = new Set(assigned.flatMap((c) => (c === undefined ? [] : [c.id])));
  const leftovers = existing.filter((c) => !used.has(c.id));
  for (const [i, c] of assigned.entries()) {
    if (c === undefined) assigned[i] = leftovers.shift();
  }

  // 3. どの草稿にも対応しない既存行を削除（子孫・userTags ごと）
  const finalUsed = new Set(assigned.flatMap((c) => (c === undefined ? [] : [c.id])));
  await removeSubtrees(
    db,
    existing.filter((c) => !finalUsed.has(c.id)).map((c) => c.id),
  );

  // 4. 書き込み。無変更行はスキップして updatedAt（= replication push）を発生させない
  const saved: ChunkDoc[] = [];
  for (const [position, draft] of drafts.entries()) {
    const prev = assigned[position];
    if (prev !== undefined && prev.content === draft.content && prev.position === position) {
      saved.push(prev);
      continue;
    }
    const next: ChunkDoc =
      prev === undefined
        ? {
            id: newDocId(),
            parentId,
            position,
            content: draft.content,
            date: null,
            polarity: null,
            updatedAt: now,
          }
        : { ...prev, position, content: draft.content, updatedAt: now };
    saved.push(toChunkDoc(await db.chunks.upsert(next)));
  }
  return saved;
}

/** 本文（コンテナ名）の変更（PATCH /chunks/:id 相当）。日付チャンクは不変条件を守る */
export async function renameChunkDoc(
  db: ZakkiDatabase,
  id: string,
  content: string,
  now: string = nowIso(),
): Promise<void> {
  const doc = await db.chunks.findOne(id).exec();
  if (doc === null) {
    throw new Error(`チャンクが存在しません: id=${id}`);
  }
  if ((doc.date ?? null) !== null) {
    throw new Error("日付チャンクの content は書き換えられません");
  }
  await doc.incrementalPatch({ content, updatedAt: now });
}

/** ユーザタグの差分同期（PUT /chunks/:id/tags 相当）。残るタグの doc は維持する */
export async function setUserTagDocs(
  db: ZakkiDatabase,
  chunkId: string,
  names: readonly string[],
  now: string = nowIso(),
): Promise<void> {
  const unique = new Set(names);
  const existing = await db.chunkUserTags.find({ selector: { chunkId } }).exec();
  await db.chunkUserTags.bulkRemove(existing.filter((d) => !unique.has(d.name)).map((d) => d.id));
  const have = new Set(existing.map((d) => d.name));
  await db.chunkUserTags.bulkInsert(
    [...unique]
      .filter((n) => !have.has(n))
      .map((name) => ({
        id: newDocId(),
        chunkId,
        name,
        updatedAt: now,
      })),
  );
}

/** 変換学習（かな → 確定）の保存。correction は local のみ（replication 対象外） */
export async function upsertCorrection(
  db: ZakkiDatabase,
  kana: string,
  chosen: string,
  now: string = nowIso(),
): Promise<void> {
  await db.corrections.upsert({ kana, chosen, updatedAt: now });
}
