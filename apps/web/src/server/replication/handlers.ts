import type { ResultAsync } from "neverthrow";
import { okAsync } from "neverthrow";
import type { DbError } from "@zakki/data/db/error.ts";
import type { Checkpoint, PullResult, PushRow } from "@zakki/web/server/replication/protocol.ts";
import { resolvePush, selectChanges } from "@zakki/web/server/replication/protocol.ts";
import type { ReplicationStore, WireDoc } from "@zakki/web/server/replication/store.ts";

/**
 * ReplicationStore（store.ts）と protocol.ts の純ロジックを合成する層（issue #42）。
 * サーバは wire doc の中身を復号せず、暗号文のまま pull/push を仲介するだけ。
 */

/**
 * cp より後の差分を limit 件まで返す。絞り込み・順序・limit は SQL 側
 * （store.listChanges）で行い、checkpoint の算出は protocol の selectChanges に
 * 委ねる（入力は絞り込み済みなので selectChanges は事実上 checkpoint 算出のみ）。
 */
export function handlePull(
  store: ReplicationStore,
  collection: string,
  cp: Checkpoint | null,
  limit: number,
): ResultAsync<PullResult<WireDoc>, DbError> {
  return store.listChanges(collection, cp, limit).map((docs) => selectChanges(docs, cp, limit));
}

/**
 * push 行を順に現在の master state と突き合わせ（resolvePush）、書き込み可なら
 * store.write する。衝突した行は master の現在状態を conflicts に積んで返す。
 */
export function handlePush(
  store: ReplicationStore,
  collection: string,
  rows: readonly PushRow<WireDoc>[],
): ResultAsync<WireDoc[], DbError> {
  return rows.reduce<ResultAsync<WireDoc[], DbError>>(
    (acc, row) =>
      acc.andThen((conflicts) =>
        store.getById(collection, row.newDocumentState.id).andThen((current) => {
          const { write, conflict } = resolvePush(current, row);
          const written = write === null ? okAsync(undefined) : store.write(collection, write);
          return written.map(() => (conflict === null ? conflicts : [...conflicts, conflict]));
        }),
      ),
    okAsync<WireDoc[], DbError>([]),
  );
}
