/**
 * クライアント DB の起動シーケンス（issue #43 の合成点）。
 *
 * sodium ready → RxDB（本番は Dexie storage）→ unlock（封筒 → パスフレーズ → DEK）
 * → replication 開始、の順で組み立てる。DEK は FieldCrypto のクロージャのみが
 * 保持し、永続ストレージ（localStorage / IndexedDB 等）へは書かない（暫定。恒久は #7）。
 *
 * 封筒が無い（暗号未プロビジョン）・入力キャンセル時は replication を開始しない
 * （暗号化できない doc を wire に出さないため。DB 自体は local で使える）。
 */
import type { RxStorage } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { ready } from "@zakki/core/crypto/sodium.ts";
import { makeFieldCrypto } from "@zakki/web/client/db/crypto.ts";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { createZakkiDb } from "@zakki/web/client/db/database.ts";
import type {
  StartReplicationOptions,
  ZakkiReplicationStates,
} from "@zakki/web/client/db/replication.ts";
import { startReplication } from "@zakki/web/client/db/replication.ts";
import type { FetchLike } from "@zakki/web/client/db/unlock.ts";
import { fetchEnvelopes, unlockWithPrompt } from "@zakki/web/client/db/unlock.ts";

export interface ClientDb {
  db: ZakkiDatabase;
  /** アンロックできなかった場合は null（同期なし・local のみ） */
  replication: ZakkiReplicationStates | null;
}

/** テストが memory storage / Hono app / スクリプト化した prompt を注入するための穴 */
export interface BootstrapOptions {
  storage?: RxStorage<unknown, unknown>;
  dbName?: string;
  fetchFn?: FetchLike;
  promptFn?: (attempt: number) => Promise<string | null>;
  replicationOptions?: Pick<StartReplicationOptions, "live" | "resyncIntervalMs" | "retryTime">;
}

/** live 同期の簡易ポーリング間隔（サーバ push 通知の実装までの暫定） */
const DEFAULT_RESYNC_INTERVAL_MS = 15_000;

const defaultPrompt = (attempt: number): Promise<string | null> =>
  Promise.resolve(
    window.prompt(
      attempt === 1
        ? "パスフレーズを入力してください（E2E 暗号のアンロック）"
        : `パスフレーズが違います。再入力してください（${attempt} 回目）`,
    ),
  );

/** DB を開き、アンロックできれば replication を開始して初回同期完了まで待つ */
export async function bootstrapClientDb(options: BootstrapOptions = {}): Promise<ClientDb> {
  await ready();
  const db = await createZakkiDb(options.storage ?? getRxStorageDexie(), options.dbName);

  const envelopes = await fetchEnvelopes(options.fetchFn);
  const dek = await unlockWithPrompt(envelopes, options.promptFn ?? defaultPrompt);
  if (dek === null) {
    return { db, replication: null };
  }

  const replication = startReplication(db, makeFieldCrypto(dek), {
    fetchFn: options.fetchFn,
    resyncIntervalMs: DEFAULT_RESYNC_INTERVAL_MS,
    ...options.replicationOptions,
  });
  const states = Object.values(replication);
  for (const state of states) {
    // 秘密（DEK・平文）は載せない。エラー種別のみログする
    state.error$.subscribe((err: { message: string }) =>
      console.error(`zakki-replication: ${err.message}`),
    );
  }
  await Promise.all(states.map((state) => state.awaitInitialReplication()));
  return { db, replication };
}
