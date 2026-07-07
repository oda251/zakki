/**
 * UI 書込みの RxDB 移行（issue #44）。
 *
 * サーバ REST（PUT /chunks/:id/children 等）に代わり、書込みはローカル RxDB
 * コレクションへ行う。replication（#43）が非同期にサーバへ反映するため、
 * ここでは wire・暗号を意識しない。意味論はサーバ実装
 * （`@zakki/data/chunk/repository.ts`）と共有する:
 * - saveChildrenDocs: 突き合わせ（既存 id の維持・削除対象の決定）は
 *   `@zakki/core/chunk/match.ts` の共通カーネル。削除は子孫（と userTags）ごと
 * - 日付チャンクは content=date の平文・書き換え禁止
 *
 * サーバ実装との意図的な差分: 無変更行の updatedAt を書き換えない
 * （デバウンス保存のたびに全子チャンクが replication push されるのを防ぐ）。
 */
import type { ChunkDraft } from "@zakki/core/chunk/chunker.ts";
import { matchDraftsToExisting } from "@zakki/core/chunk/match.ts";
import type { ChunkDoc, LinkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { byPosition, toChunkDoc } from "@zakki/web/client/db/docs.ts";
import { dateChunkId, docId, linkDocId, newDocId } from "@zakki/web/client/db/ids.ts";

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
  // サーバの FK cascade に相当: 消えたチャンクの userTags・links も落とす
  const tags = await db.chunkUserTags.find({ selector: { chunkId: { $in: ids } } }).exec();
  const links = await db.links
    .find({ selector: { $or: [{ fromChunkId: { $in: ids } }, { toChunkId: { $in: ids } }] } })
    .exec();
  await Promise.all([
    db.chunkUserTags.bulkRemove(tags.map((t) => t.id)),
    db.links.bulkRemove(links.map((l) => l.id)),
  ]);
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

  // 突き合わせはサーバ（repository.saveChildren）と共有する純カーネルに委譲する
  const { assigned, removed } = matchDraftsToExisting(existing, drafts);
  await removeSubtrees(
    db,
    removed.map((c) => c.id),
  );

  // 書き込み。無変更行はスキップして updatedAt（= replication push）を発生させず、
  // 変更行は 1 回の bulkUpsert（= 1 トランザクション・liveQuery 1 emit）にまとめる
  const writes: ChunkDoc[] = [];
  const saved = drafts.map((draft, position): ChunkDoc => {
    const prev = assigned[position];
    if (prev !== undefined && prev.content === draft.content && prev.position === position) {
      return prev;
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
    writes.push(next);
    return next;
  });
  if (writes.length > 0) {
    const result = await db.chunks.bulkUpsert(writes);
    const failure = result.error[0];
    if (failure !== undefined) {
      throw new Error(`chunk の保存に失敗しました: ${failure.status}`);
    }
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
  const have = new Set(existing.map((d) => d.name));
  // 削除と挿入は互いに独立（別 doc）なので重ねる
  await Promise.all([
    db.chunkUserTags.bulkRemove(existing.filter((d) => !unique.has(d.name)).map((d) => d.id)),
    db.chunkUserTags.bulkInsert(
      [...unique]
        .filter((n) => !have.has(n))
        .map((name) => ({
          id: newDocId(),
          chunkId,
          name,
          updatedAt: now,
        })),
    ),
  ]);
}

/**
 * 数珠繋ぎリンクの永続化（#77。graph store の manualEdges セッションローカル実装を置換）。
 * かつての data 層 addManualLink と同じ不変条件: from < to 正規化・自己リンクと
 * 既存ペアは no-op（updatedAt を書き換えず、無駄な replication push を出さない）。
 * id はペアから決定的（{@link linkDocId}）で、多端末でも同一 doc に収束する。
 */
export async function addLinkDocs(
  db: ZakkiDatabase,
  drafts: readonly { from: number; to: number }[],
  now: string = nowIso(),
): Promise<void> {
  const candidates = new Map<string, LinkDoc>();
  for (const d of drafts) {
    if (d.from === d.to) continue;
    const [from, to] = d.from < d.to ? [d.from, d.to] : [d.to, d.from];
    const id = linkDocId(from, to);
    candidates.set(id, {
      id,
      fromChunkId: docId(from),
      toChunkId: docId(to),
      score: 1,
      origin: "manual",
      updatedAt: now,
    });
  }
  if (candidates.size === 0) return;
  const existing = await db.links.findByIds([...candidates.keys()]).exec();
  const inserts = [...candidates.values()].filter((doc) => !existing.has(doc.id));
  if (inserts.length === 0) return;
  const result = await db.links.bulkInsert(inserts);
  const failure = result.error[0];
  if (failure !== undefined) {
    throw new Error(`リンクの保存に失敗しました: ${failure.status}`);
  }
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
