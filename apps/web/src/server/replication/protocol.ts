/**
 * RxDB replication のサーバ側プロトコル核（純ロジック）。
 * サーバは暗号文を同期する dumb store であり、doc の中身は復号しない。
 * doc は id/updatedAt/_deleted を持つ（他フィールドは passthrough）。
 */

export interface Checkpoint {
  id: string;
  updatedAt: string;
}

export interface PullResult<T> {
  documents: T[];
  checkpoint: Checkpoint | null;
}

export interface PushRow<T> {
  assumedMasterState: T | null;
  newDocumentState: T;
}

export interface ReplDoc {
  id: string;
  updatedAt: string;
  _deleted: boolean;
}

const compareByUpdatedAtThenId = (a: Checkpoint, b: Checkpoint): number => {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};

const isAfterCheckpoint = (doc: Checkpoint, cp: Checkpoint): boolean =>
  compareByUpdatedAtThenId(doc, cp) > 0;

/**
 * cp より厳密に後の doc を (updatedAt,id) 昇順で最大 limit 件返す。
 * 返す documents が 1 件以上なら checkpoint は末尾 doc、0 件なら入力 cp をそのまま返す。
 */
export function selectChanges<T extends ReplDoc>(
  docs: readonly T[],
  cp: Checkpoint | null,
  limit: number,
): PullResult<T> {
  const sorted = docs.toSorted(compareByUpdatedAtThenId);
  const filtered = cp === null ? sorted : sorted.filter((d) => isAfterCheckpoint(d, cp));
  const documents = filtered.slice(0, limit);
  const last = documents.at(-1);
  const checkpoint: Checkpoint | null =
    last === undefined ? cp : { id: last.id, updatedAt: last.updatedAt };
  return { documents, checkpoint };
}

/**
 * push 行を現在の master state と突き合わせ、楽観ロックで衝突を検出する。
 * assumedMasterState.updatedAt と current.updatedAt が一致すれば書き込み、
 * 不一致なら master を上書きせず現在の状態を conflict として返す。
 */
export function resolvePush<T extends ReplDoc>(
  current: T | undefined,
  row: PushRow<T>,
): { write: T | null; conflict: T | null } {
  const assumedKey = row.assumedMasterState?.updatedAt ?? null;
  const currentKey = current?.updatedAt ?? null;
  if (assumedKey === currentKey) {
    return { write: row.newDocumentState, conflict: null };
  }
  return { write: null, conflict: current ?? null };
}
