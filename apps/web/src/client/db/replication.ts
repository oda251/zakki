/**
 * RxDB replication のクライアント配線（issue #43）。
 *
 * コレクションごとに `replicateRxCollection` でサーバ endpoint
 * （`POST ${API_BASE}/replication/:collection/pull|push`, #42）へ接続する。
 * 暗号境界は Phase 2 の modifier（push = *Push で暗号化 + fingerprint /
 * pull = *Pull で復号）で、平文文字列フィールドは wire 上・サーバ上で常に
 * 暗号文のみ（#28。構造のみの links は平文 wire — modifiers.ts の判断コメント）。
 *
 * どのコレクションを同期するかは {@link REPLICATION_POLICY} が SSOT
 * （コレクション追加時に宣言漏れを型エラーで検出する, #77 / #43 レビュー指摘）。
 */
import { interval, map } from "rxjs";
import type { Observable } from "rxjs";
import type { RxCollection, WithDeleted } from "rxdb";
import { replicateRxCollection } from "rxdb/plugins/replication";
import type { RxReplicationState } from "rxdb/plugins/replication";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { request } from "@zakki/web/client/api/client.ts";
import type { FieldCrypto } from "@zakki/web/client/db/crypto.ts";
import type { ZakkiCollections, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import {
  chunkPull,
  chunkPush,
  linkPull,
  linkPush,
  tagPull,
  tagPush,
  userTagPull,
  userTagPush,
} from "@zakki/web/client/db/modifiers.ts";
import { API_BASE } from "@zakki/web/shared/api-base.ts";

/** サーバの checkpoint（server/replication/protocol.ts と同形）。空 pull では null のまま */
export interface ReplicationCheckpoint {
  id: string;
  updatedAt: string;
}

type Checkpoint = ReplicationCheckpoint | null;

export interface StartReplicationOptions {
  /** 省略時はグローバル fetch（本番）。テストは Hono `app.request` を注入する */
  fetchFn?: FetchLike;
  /** false で 1 回きり同期（in sync 後に自動終了）。既定 true */
  live?: boolean;
  /** live 時に RESYNC を流す間隔（ms）。サーバ push 通知が無いための簡易ポーリング */
  resyncIntervalMs?: number;
  /** 失敗時の再試行間隔（ms）。既定は RxDB 既定（5000） */
  retryTime?: number;
}

/**
 * 全コレクションの replication 方針の SSOT（#77。#43 レビュー指摘
 * 「corrections がサイレント除外」の解消）。ZakkiCollections にコレクションを
 * 追加すると satisfies が型エラーになり、ここでの replicated / local の明示宣言と
 * {@link startReplication} の配線（{@link ZakkiReplicationStates} が本表から派生）が
 * 強制される。local にする場合は理由をコメントで残す。
 */
export const REPLICATION_POLICY = {
  chunks: "replicated",
  tags: "replicated",
  chunkUserTags: "replicated",
  links: "replicated",
  // 変換学習はデバイスローカル運用（暗号 modifier 未定義。同期化は将来 issue）
  corrections: "local",
} as const satisfies Record<keyof ZakkiCollections, "replicated" | "local">;

/** REPLICATION_POLICY で "replicated" と宣言されたコレクション名 */
type ReplicatedName = {
  [K in keyof ZakkiCollections]: (typeof REPLICATION_POLICY)[K] extends "replicated" ? K : never;
}[keyof ZakkiCollections];

type DocOf<K extends keyof ZakkiCollections> =
  ZakkiCollections[K] extends RxCollection<infer D> ? D : never;

export type ZakkiReplicationStates = {
  [K in ReplicatedName]: RxReplicationState<DocOf<K>, Checkpoint>;
};

type Post = (path: string, body: unknown) => Promise<unknown>;

function makePost(fetchFn: FetchLike | undefined): Post {
  return (path, body) =>
    request<unknown>(
      `/replication/${path}`,
      { method: "POST", body: JSON.stringify(body) },
      fetchFn,
    );
}

interface WireBase {
  id: string;
  updatedAt: string;
  _deleted: boolean;
}

/** 1 コレクション分の replicateRxCollection 配線（pull=復号 / push=暗号化） */
function replicateWired<Doc, W extends WireBase>(opts: {
  name: string;
  collection: RxCollection<Doc>;
  toWire: (doc: WithDeleted<Doc>) => W;
  fromWire: (wire: W) => WithDeleted<Doc>;
  post: Post;
  live: boolean;
  retryTime: number | undefined;
  stream$: Observable<"RESYNC"> | undefined;
}): RxReplicationState<Doc, Checkpoint> {
  const { name, post, fromWire } = opts;
  return replicateRxCollection<Doc, Checkpoint>({
    // checkpoint は endpoint 単位で保存されるため API_BASE を識別子に含める
    replicationIdentifier: `zakki-replication-${name}-${API_BASE}`,
    collection: opts.collection,
    live: opts.live,
    retryTime: opts.retryTime,
    waitForLeadership: false,
    pull: {
      handler: async (checkpoint, batchSize) => {
        const raw = await post(`${name}/pull`, {
          checkpoint: checkpoint ?? null,
          limit: batchSize,
        });
        // documents は暗号文 wire のままで、直後の pull.modifier（fromWire）が doc 形へ復号する
        // oxlint-disable-next-line typescript/consistent-type-assertions -- 自前サーバの wire JSON 境界（client.ts の request と同じ扱い）
        return raw as { documents: WithDeleted<Doc>[]; checkpoint: Checkpoint };
      },
      modifier: (wire: W) => fromWire(wire),
      stream$: opts.stream$,
    },
    push: {
      handler: async (rows) => {
        const body = {
          // JSON.stringify は undefined キーを落とすため、サーバスキーマの nullable に合わせて null 化する
          rows: rows.map((row) => ({
            assumedMasterState: row.assumedMasterState ?? null,
            newDocumentState: row.newDocumentState,
          })),
        };
        const raw = await post(`${name}/push`, body);
        // conflicts は pull.modifier を通らないため、ここで復号（fromWire）して doc 形で返す
        // oxlint-disable-next-line typescript/consistent-type-assertions -- 自前サーバの wire JSON 境界（client.ts の request と同じ扱い）
        const { conflicts } = raw as { conflicts: W[] };
        return conflicts.map(fromWire);
      },
      modifier: (doc) => opts.toWire(doc),
    },
  });
}

/**
 * 全コレクションの replication を開始する。`fc` が束ねる DEK はクロージャのみで
 * 保持され、永続化されない。ready 済み sodium が前提（呼び出し側の責務）。
 */
export function startReplication(
  db: ZakkiDatabase,
  fc: FieldCrypto,
  options: StartReplicationOptions = {},
): ZakkiReplicationStates {
  const post = makePost(options.fetchFn);
  const live = options.live ?? true;
  const retryTime = options.retryTime;
  // サーバからの push 通知は未実装のため、live では一定間隔で RESYNC を流して追随する
  const stream$: Observable<"RESYNC"> | undefined =
    live && options.resyncIntervalMs !== undefined
      ? interval(options.resyncIntervalMs).pipe(map(() => "RESYNC" as const))
      : undefined;

  return {
    chunks: replicateWired({
      name: "chunks",
      collection: db.chunks,
      toWire: (doc) => chunkPush(fc, doc),
      fromWire: (wire) => chunkPull(fc, wire),
      post,
      live,
      retryTime,
      stream$,
    }),
    tags: replicateWired({
      name: "tags",
      collection: db.tags,
      toWire: (doc) => tagPush(fc, doc),
      fromWire: (wire) => tagPull(fc, wire),
      post,
      live,
      retryTime,
      stream$,
    }),
    chunkUserTags: replicateWired({
      name: "chunkUserTags",
      collection: db.chunkUserTags,
      toWire: (doc) => userTagPush(fc, doc),
      fromWire: (wire) => userTagPull(fc, wire),
      post,
      live,
      retryTime,
      stream$,
    }),
    links: replicateWired({
      name: "links",
      collection: db.links,
      toWire: (doc) => linkPush(doc),
      fromWire: (wire) => linkPull(wire),
      post,
      live,
      retryTime,
      stream$,
    }),
  };
}
