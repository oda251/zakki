/**
 * コントロールプレーン（apps/api）クライアント（issue #105 / docs/MULTIUSER.md「ログイン（OIDC）」）。
 *
 * ログインは OIDC（Authorization Code + PKCE, Google）。ブラウザは
 * `GET /auth/oidc/:provider/start` へ遷移して同意を済ませ、コールバックは
 * `APP_ORIGIN/#login=<code>`（または `#login_error=<reason>`）で戻ってくる。
 * その使い捨て handoff code を `POST /auth/login/exchange` に渡してセッション JWT を得る
 * （{@link ControlPlaneClient.completeLogin}）。得たセッションで `GET /me/db`（#101）を叩き、
 * 「自分の Turso DB の所在と短命トークン」を {@link RemoteDbConnection} / {@link remoteIdentity}
 * に写す。ここに現れるのは **どの DB を開くか** だけで、DEK・本文は一切通らない
 * （E2E, docs/RESEARCH.md §6）。
 *
 * 設計上の要点:
 * - **セッション JWT はメモリだけ**に持つ（localStorage / sessionStorage / Cookie に
 *   書かない）。リロードで消えるが、再ログインは OIDC の同意 1 回なので UX 劣化は小。
 * - handoff code は fragment（サーバへ送られない）で受け取り、読んだら即座に
 *   `history.replaceState` で消す（履歴に残さない, {@link resolveRemoteSession}）。
 * - E2E 暗号のパスキーアンロック（{@link import("@zakki/web/client/db/passkey.ts")}）は
 *   ログインとは切り離した（docs/MULTIUSER.md「ログイン（OIDC）」）。この層は関与しない。
 */
import * as v from "valibot";
import type { RemoteDbConnection } from "@zakki/core/identity/remote.ts";
import { isConnectionExpiring, remoteIdentity } from "@zakki/core/identity/remote.ts";
import type { Identity } from "@zakki/core/identity/types.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { ApiRequestError, request } from "@zakki/web/client/api/client.ts";

// --- サーバ応答のスキーマ ---------------------------------------------------
//
// HTTP JSON は untyped の境界なので valibot で検証してから型を名乗る（issue #48 の流儀）。
// 未知のキーは無視する（サーバが将来足すフィールドで壊れない）。

/** `POST /auth/login/exchange` が返すセッション */
const SessionSchema = v.object({
  accountId: v.string(),
  token: v.string(),
  expiresAt: v.number(),
  // サイドバー下部のアカウント表示用（issue #159）。メールと OIDC プロバイダ
  account: v.object({
    email: v.nullable(v.string()),
    provider: v.object({ id: v.string(), name: v.string() }),
  }),
});

/** `GET /me/db` の応答（#101） */
const DbConnectionSchema = v.object({
  dbUrl: v.string(),
  token: v.string(),
  expiresAt: v.number(),
});

/** `GET /auth/providers` の応答 */
const ProvidersSchema = v.object({
  providers: v.array(v.object({ id: v.string(), name: v.string() })),
});

/** メモリ保持のセッション。永続化しない */
export interface ControlPlaneSession {
  readonly accountId: string;
  readonly token: string;
  /** epoch 秒 */
  readonly expiresAt: number;
  /** 表示用アカウント（メール + OIDC プロバイダ, issue #159） */
  readonly account: {
    readonly email: string | null;
    readonly provider: { readonly id: string; readonly name: string };
  };
}

export interface ControlPlaneOptions {
  /** apps/api の base URL（末尾スラッシュ無し。例 https://api.zakki.example.com） */
  readonly baseUrl: string;
  /** 省略時はグローバル fetch。テストは apps/api の Hono `app.request` を注入する */
  readonly fetchFn?: FetchLike;
  /** 現在時刻（ms）。トークン失効の先回り判定に使う。テストが固定する */
  readonly now?: () => number;
}

export interface ControlPlaneClient {
  /** 現在のセッション（未ログインなら null）。メモリのみ */
  readonly session: () => ControlPlaneSession | null;
  /**
   * ログイン handoff code（`#login=<code>`）を交換してセッションを得る。
   * 非 2xx は {@link ApiRequestError} を投げ、セッションは null のまま
   * （呼び出し側はプロバイダ一覧を出し直せる）。
   */
  readonly completeLogin: (code: string) => Promise<ControlPlaneSession>;
  /** `GET /me/db`。失効が近いときだけ取り直す（それ以外はキャッシュを返す） */
  readonly connect: () => Promise<RemoteDbConnection>;
  /** 接続情報を Identity（RemoteIdentity）へ写して返す */
  readonly identity: () => Promise<Identity>;
  /**
   * 全端末ログアウト（`POST /auth/logout`, issue #117 / #159）。
   * 成功したらメモリ上のセッション・接続情報を捨てる。未ログインは何もしない。
   */
  readonly logout: () => Promise<void>;
  /**
   * 中継サーバ（apps/web）向けの fetch。セッション JWT を Authorization ヘッダで
   * 添える。replication / 封筒配布はこれを `fetchFn` として使うことで、
   * 「どのアカウントの DB を中継するか」がサーバ側で決まる。
   */
  readonly authorizedFetch: FetchLike;
}

/** JSON を投げて検証済みの値を得る。非 2xx は {@link ApiRequestError}（client.ts と同じ形） */
async function requestJson<T>(
  fetchFn: FetchLike,
  url: string,
  schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchFn(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : res.statusText;
    throw new ApiRequestError(res.status, message);
  }
  return v.parse(schema, await res.json());
}

export function createControlPlaneClient(options: ControlPlaneOptions): ControlPlaneClient {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.baseUrl.replace(/\/+$/, "");
  // セッション・接続情報はこのクロージャだけが持つ（永続ストレージへ書かない）
  let session: ControlPlaneSession | null = null;
  let connection: RemoteDbConnection | null = null;

  const requireSession = (): ControlPlaneSession => {
    if (session === null) {
      throw new ApiRequestError(401, "コントロールプレーンにログインしていません");
    }
    return session;
  };

  const completeLogin = async (code: string): Promise<ControlPlaneSession> => {
    // 失敗時（使用済み・期限切れ）は例外が伝播し、session は書き換えない
    const result = await requestJson(fetchFn, `${base}/auth/login/exchange`, SessionSchema, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    session = result;
    connection = null;
    return result;
  };

  const connect = async (): Promise<RemoteDbConnection> => {
    const current = requireSession();
    const nowSec = Math.floor(now() / 1000);
    if (connection !== null && !isConnectionExpiring(connection, nowSec)) return connection;
    const fetched = await requestJson(fetchFn, `${base}/me/db`, DbConnectionSchema, {
      method: "GET",
      headers: { authorization: `Bearer ${current.token}` },
    });
    connection = { accountId: current.accountId, ...fetched };
    return connection;
  };

  const authorizedFetch: FetchLike = (input, init) => {
    if (session === null) return fetchFn(input, init);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${session.token}`);
    return fetchFn(input, { ...init, headers });
  };

  const logout = async (): Promise<void> => {
    // ログインしていないときは何もしない（二重呼び出し等で fetch を発行しない, R20）
    if (session === null) return;
    const res = await fetchFn(`${base}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (!res.ok) throw new ApiRequestError(res.status, "ログアウトに失敗しました");
    // サーバがセッション世代を進めたので、メモリ上のセッションも捨てて signed-out に戻す
    session = null;
    connection = null;
  };

  return {
    session: () => session,
    completeLogin,
    connect,
    identity: async () => remoteIdentity(await connect()),
    authorizedFetch,
    logout,
  };
}

// --- ログイン fragment（`APP_ORIGIN/#login=<code>` / `#login_error=<reason>`） ----------

/** URL fragment から読んだログインの結果 */
export type LoginFragment =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "error"; readonly reason: string };

/**
 * ログイン後に apps/api がリダイレクトする URL fragment を読む（純関数）。
 * `#login=<code>` は成功、`#login_error=<reason>` は失敗、それ以外
 * （無関係な fragment・空・code/reason が空文字）は null。
 */
export function readLoginFragment(hash: string): LoginFragment | null {
  if (!hash.startsWith("#")) return null;
  const params = new URLSearchParams(hash.slice(1));
  const code = params.get("login");
  if (code !== null) return code === "" ? null : { kind: "code", code };
  const reason = params.get("login_error");
  if (reason !== null) return reason === "" ? null : { kind: "error", reason };
  return null;
}

// --- 構成の選択（設定ベース） ----------------------------------------------

/** `GET /api/config`（中継サーバが自分の設定から返す）。秘密は含まない */
const ClientConfigSchema = v.object({ controlPlaneUrl: v.nullable(v.string()) });

/** ログインボタン 1 個分（プロバイダ一覧 + 遷移先） */
export interface RemoteProviderOption {
  readonly id: string;
  readonly name: string;
  /** ここへ `window.location.assign` すれば OIDC 同意へ遷移する */
  readonly loginUrl: string;
}

/** `GET /auth/providers` を読み、開始 URL を組んで返す */
async function listProviders(
  baseUrl: string,
  fetchFn: FetchLike | undefined,
): Promise<RemoteProviderOption[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const body = await requestJson(fetchFn ?? fetch, `${base}/auth/providers`, ProvidersSchema, {
    method: "GET",
  });
  return body.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    loginUrl: `${base}/auth/oidc/${provider.id}/start`,
  }));
}

/**
 * 起動時の構成選択の結果（issue #105 / docs/MULTIUSER.md「ログイン（OIDC）」）。
 * `fetchFn` をそのまま `bootstrapClientDb` に渡すと、封筒取得・replication が
 * 「自分の DB」へ向く（中継の宛先はサーバが解決する）。
 */
/** 未ログイン。ログインボタン（store/auth.ts）はこの形をそのまま持つ */
export interface SignedOutSession {
  readonly status: "signed-out";
  readonly providers: readonly RemoteProviderOption[];
  /** fragment のエラー理由、交換失敗なら `"exchange"`、それ以外は null */
  readonly error: string | null;
}

export type RemoteSession =
  | {
      readonly status: "signed-in";
      readonly identity: Identity;
      readonly fetchFn: FetchLike;
      readonly client: ControlPlaneClient;
    }
  | SignedOutSession;

/**
 * 起動時の構成選択（issue #105）。**設定ベース**で、判断材料は中継サーバが返す
 * `controlPlaneUrl` だけ:
 * - 未設定 → null（従来の単一ユーザ構成。呼び出し側は何も変えずに起動する）
 * - 設定あり → fragment にログイン handoff code があれば交換してセッションを得る。
 *   無い・交換に失敗した場合は signed-out（プロバイダ一覧と開始 URL 付き）を返す
 *
 * fragment（code・エラーいずれか）が有れば `clearHash` を 1 回だけ呼ぶ（code は
 * 単回使用で、履歴に残しておく意味が無いため）。既定は `window.location.hash` /
 * パス・クエリを保ったままの `history.replaceState`。
 */
export async function resolveRemoteSession(
  options: {
    fetchFn?: FetchLike;
    hash?: string;
    clearHash?: () => void;
  } = {},
): Promise<RemoteSession | null> {
  const raw = await request<unknown>("/config", undefined, options.fetchFn).catch(() => null);
  const parsed = v.safeParse(ClientConfigSchema, raw);
  const baseUrl = parsed.success ? parsed.output.controlPlaneUrl : null;
  if (baseUrl === null) return null;

  const hash = options.hash ?? window.location.hash;
  const clearHash =
    options.clearHash ??
    (() => {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    });
  const fragment = readLoginFragment(hash);
  if (fragment !== null) clearHash();

  const signedOut = async (error: string | null): Promise<RemoteSession> => ({
    status: "signed-out",
    providers: await listProviders(baseUrl, options.fetchFn),
    error,
  });

  if (fragment?.kind === "code") {
    const client = createControlPlaneClient({
      baseUrl,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    });
    try {
      await client.completeLogin(fragment.code);
      return {
        status: "signed-in",
        identity: await client.identity(),
        fetchFn: client.authorizedFetch,
        client,
      };
    } catch {
      // 使用済み・期限切れ（#login= が残ったままリロードした等）。秘密は載せない
      return signedOut("exchange");
    }
  }

  return signedOut(fragment?.kind === "error" ? fragment.reason : null);
}
