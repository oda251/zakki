import * as v from "valibot";
import type { Identity } from "@zakki/core/identity/types.ts";
import { isConnectionExpiring, remoteIdentity } from "@zakki/core/identity/remote.ts";
import type { Db } from "@zakki/data/db/client.ts";

/**
 * マルチユーザ構成での「このリクエストはどの DB を中継するか」の解決（issue #105）。
 *
 * 現行アーキ（ブラウザ → apps/web が replication を中継 → DB）を維持したまま、
 * 中継先だけをアカウントごとに切り替える。ブラウザは自分のセッション JWT を
 * Authorization ヘッダに載せるだけで、**DB のトークンや URL をサーバへ渡さない**:
 * 中継サーバはコントロールプレーン（apps/api）へ同じセッションで問い合わせ、
 * `GET /me/db` の応答（信頼できる出どころ）から接続先を得る。クライアントの申告した
 * URL へ繋ぐ設計にしないのは、任意の宛先に接続させられる穴を作らないため。
 *
 * この経路にも **DEK・PRF 出力・平文は現れない**: 中継するのは暗号文の wire doc と
 * 封筒（KEK 無しには開けない）だけで、DB トークンは復号鍵ではない。
 *
 * 単一ユーザ self-host（コントロールプレーン URL 未設定）では、この解決器自体が
 * 組み立てられず、サーバは従来どおり自分の 1 つの DB を使う（LocalIdentity 経路は無改修）。
 */

/** fetch 互換の最小型（テストが apps/api の Hono `app.request` を注入するための境界） */
export type ServerFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const AccountSchema = v.object({ accountId: v.string() });

const DbConnectionSchema = v.object({
  dbUrl: v.string(),
  token: v.string(),
  expiresAt: v.number(),
});

export interface RemoteDbResolverOptions {
  /** apps/api の base URL（末尾スラッシュ無し） */
  readonly controlPlaneUrl: string;
  /**
   * 接続情報から DB を開くアダプタ。本番は `openRemoteDb`（@zakki/data）で、
   * テストはローカル libSQL を返す fake を注入する（Turso 実体はローカルで再現できない）。
   */
  readonly openUserDb: (identity: Identity) => Promise<Db>;
  /** 省略時はグローバル fetch */
  readonly fetchFn?: ServerFetchLike;
  /** 現在時刻（ms）。トークン失効判定に使う */
  readonly now?: () => number;
}

/** リクエスト → そのアカウントの DB（未認証・解決不能なら null） */
export type ResolveDb = (req: Request) => Promise<Db | null>;

/** キャッシュ 1 件。DB トークンの寿命に合わせて作り直す（libsql クライアントは作成時のトークンを持つ） */
interface CacheEntry {
  readonly db: Db;
  /** epoch 秒。DB トークンの失効時刻 */
  readonly expiresAt: number;
}

/** `Authorization: Bearer <jwt>` を取り出す（形式不正・不在は null） */
function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token === undefined || token === "") return null;
  return token;
}

async function getJson<T>(
  fetchFn: ServerFetchLike,
  url: string,
  token: string,
  schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
): Promise<T | null> {
  const res = await fetchFn(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  const parsed = v.safeParse(schema, body);
  return parsed.success ? parsed.output : null;
}

/**
 * セッション JWT → そのアカウントの DB ハンドルを返す解決器を作る。
 *
 * キャッシュはセッション JWT 単位（同じ端末からの replication が毎回 2 往復しないため）で、
 * DB トークンの失効に合わせて破棄する。JWT 自体はキーとしてのみ扱い、ログに出さない。
 */
export function createRemoteDbResolver(options: RemoteDbResolverOptions): ResolveDb {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.controlPlaneUrl.replace(/\/+$/, "");
  const cache = new Map<string, CacheEntry>();
  // 解決中の Promise。ブラウザ起動直後は封筒取得と各 collection の replication が
  // 同時に来るので、これが無いと同じセッションで解決が並列に走り、往復・DB 作成・
  // migrate が多重になる（初回ログイン時は DB が空で、migration の CREATE TABLE は
  // IF NOT EXISTS を持たないため実 Turso では衝突しうる）。開いたハンドルの取り違え
  // （後勝ちで孤児になる）もこれで消える
  const inFlight = new Map<string, Promise<Db | null>>();

  const resolve = async (token: string, nowSec: number): Promise<Db | null> => {
    // 信頼できる出どころ（コントロールプレーン）に「あなたは誰で、どの DB か」を訊く。
    // 未ログイン・失効セッションはここで 401 になり、解決不能（null）になる
    const account = await getJson(fetchFn, `${base}/auth/me`, token, AccountSchema);
    if (account === null) return null;
    const fetched = await getJson(fetchFn, `${base}/me/db`, token, DbConnectionSchema);
    if (fetched === null) return null;
    const connection = { accountId: account.accountId, ...fetched };
    // 受け取った直後に失効している（時計ずれ・極端に短い TTL）ものは使わない
    if (isConnectionExpiring(connection, nowSec, 0)) return null;

    const db = await options.openUserDb(remoteIdentity(connection));
    cache.set(token, { db, expiresAt: connection.expiresAt });
    return db;
  };

  return async (req) => {
    const token = bearer(req);
    if (token === null) return null;
    const nowSec = Math.floor(now() / 1000);

    // 失効した項目は都度掃除する（セッションは短命なので、これで際限なく増えない）
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= nowSec) cache.delete(key);
    }
    const cached = cache.get(token);
    if (cached !== undefined) return cached.db;

    const pending = inFlight.get(token);
    if (pending !== undefined) return pending;

    const task = resolve(token, nowSec).finally(() => inFlight.delete(token));
    inFlight.set(token, task);
    return task;
  };
}
