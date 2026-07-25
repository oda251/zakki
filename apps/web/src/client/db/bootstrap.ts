/**
 * クライアント DB の起動シーケンス（issue #43 の合成点）。
 *
 * sodium ready → RxDB（本番は Dexie storage）→ unlock（封筒 → passkey PRF、
 * 失敗時はパスフレーズ → DEK, #104）→ replication 開始、の順で組み立てる。DEK は
 * FieldCrypto と passkey 登録クロージャのみが保持し、永続ストレージ
 * （localStorage / sessionStorage / IndexedDB 等）へは書かない。
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
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";
import type { CredentialsApi } from "@zakki/web/client/db/passkey.ts";
import {
  browserCredentials,
  createPasskeyCredential,
  savePasskeyEnvelope,
  unlockWithPasskey,
} from "@zakki/web/client/db/passkey.ts";
import { fetchEnvelopes, unlockWithPrompt } from "@zakki/web/client/db/unlock.ts";

/**
 * UI（設定パネル）へ渡す passkey の状態と操作（#104）。DEK 自体は外へ出さず、
 * すべてクロージャの中に閉じる。
 *
 * 登録が create / save の 2 段に分かれ、アンロックにも再試行口があるのは
 * WebKit が WebAuthn 呼び出しに **ユーザジェスチャ** を要求するため
 * （出典: https://webkit.org/blog/11312/meet-face-id-and-touch-id-for-the-web/ ）。
 * 起動直後の自動試行は非ジェスチャ文脈なので Safari では失敗し、UI から
 * クリック起点で呼び直せる必要がある。
 */
export interface PasskeyControls {
  /** この環境で WebAuthn（PRF）を試せるか。false ならパスフレーズのみ */
  available: boolean;
  /** サーバに passkey 封筒が既にあるか */
  enrolled: boolean;
  /** アンロック済み + WebAuthn 利用可のときだけ非 null。パスキーを作成し credentialId を返す */
  createCredential: (() => Promise<string>) | null;
  /** 作成済み credential の PRF を評価して封筒を保存する（Safari では別クリックで呼び直せる） */
  saveEnvelope: ((credentialId: string) => Promise<void>) | null;
  /**
   * 未アンロック + passkey 封筒あり + WebAuthn 利用可のときだけ非 null。
   * ユーザジェスチャ起点で passkey アンロックを再試行する。成功すれば（DB は同じ
   * インスタンスのまま）replication が開始され、更新後の操作一式を返す。
   * 失敗時は `unlocked: false` で、返る controls から再度試せる。
   */
  unlock: (() => Promise<{ unlocked: boolean; passkey: PasskeyControls }>) | null;
}

export interface ClientDb {
  db: ZakkiDatabase;
  /** アンロックできなかった場合は null（後から `passkey.unlock()` で開始されうる） */
  replication: ZakkiReplicationStates | null;
  passkey: PasskeyControls;
}

/** テストが memory storage / Hono app / スクリプト化した prompt・認証器を注入するための穴 */
export interface BootstrapOptions {
  storage?: RxStorage<unknown, unknown>;
  dbName?: string;
  fetchFn?: FetchLike;
  promptFn?: (attempt: number) => Promise<string | null>;
  /** WebAuthn adapter。既定は {@link browserCredentials}（未対応環境では null） */
  credentialsApi?: CredentialsApi | null;
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

/**
 * DB を開き、アンロックできれば replication を開始する。初回同期は待たない
 * （UI はローカルレプリカを即座に読める local-first。オフラインで pull が
 * pending のままでも起動がブロックされない, #44）。
 */
export async function bootstrapClientDb(options: BootstrapOptions = {}): Promise<ClientDb> {
  // 3 つは互いに独立（sodium 初期化・IndexedDB オープン・封筒フェッチ）なので重ねる。
  // 封筒フェッチ失敗（オフライン・サーバ未起動）は「同期なし・local のみ」に落とす
  const [, db, envelopes] = await Promise.all([
    ready(),
    createZakkiDb(options.storage ?? getRxStorageDexie(), options.dbName),
    fetchEnvelopes(options.fetchFn).catch((err: unknown) => {
      console.warn(`zakki-db: 封筒の取得に失敗（local のみで起動）: ${String(err)}`);
      return null;
    }),
  ]);
  // 1) passkey 封筒があれば PRF で無言アンロック（#104） → 2) 失敗・キャンセル・未対応なら
  // 従来のパスフレーズプロンプト。順序はユーザ操作の軽い順（生体認証 → 入力）。
  const credentialsApi =
    options.credentialsApi === undefined ? browserCredentials() : options.credentialsApi;
  const dek =
    envelopes === null
      ? null
      : ((await unlockWithPasskey(envelopes, credentialsApi)) ??
        (await unlockWithPrompt(envelopes, options.promptFn ?? defaultPrompt)));
  return composeClientDb(db, envelopes, credentialsApi, options, dek);
}

/**
 * DEK の有無から replication と passkey 操作を組み立てる。ジェスチャ起点の再アンロック
 * （`passkey.unlock`）も同じ関数を通るので、起動時と再試行時で経路が分岐しない。
 */
function composeClientDb(
  db: ZakkiDatabase,
  envelopes: readonly CryptoEnvelope[] | null,
  credentialsApi: CredentialsApi | null,
  options: BootstrapOptions,
  dek: Uint8Array | null,
): ClientDb {
  const hasPasskeyEnvelope = (envelopes ?? []).some((e) => e.kind === "passkey");
  const passkey: PasskeyControls = {
    available: credentialsApi !== null,
    enrolled: hasPasskeyEnvelope,
    createCredential:
      dek === null || credentialsApi === null
        ? null
        : () => createPasskeyCredential(credentialsApi),
    saveEnvelope:
      dek === null || credentialsApi === null
        ? null
        : (credentialId) =>
            savePasskeyEnvelope(dek, credentialsApi, credentialId, { fetchFn: options.fetchFn }),
    unlock:
      dek !== null || credentialsApi === null || envelopes === null || !hasPasskeyEnvelope
        ? null
        : async () => {
            const next = composeClientDb(
              db,
              envelopes,
              credentialsApi,
              options,
              await unlockWithPasskey(envelopes, credentialsApi),
            );
            return { unlocked: next.replication !== null, passkey: next.passkey };
          },
  };
  if (dek === null) {
    return { db, replication: null, passkey };
  }

  const replication = startReplication(db, makeFieldCrypto(dek), {
    fetchFn: options.fetchFn,
    resyncIntervalMs: DEFAULT_RESYNC_INTERVAL_MS,
    ...options.replicationOptions,
  });
  for (const state of Object.values(replication)) {
    // 秘密（DEK・平文）は載せない。エラー種別のみログする
    state.error$.subscribe((err: { message: string }) =>
      console.error(`zakki-replication: ${err.message}`),
    );
  }
  return { db, replication, passkey };
}
