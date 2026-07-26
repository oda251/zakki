/**
 * コントロールプレーン（apps/api）クライアント（issue #105）。
 *
 * パスキーでの登録・ログイン（#100 の 4 エンドポイント）→ `GET /me/db`（#101）で
 * 「自分の Turso DB の所在と短命トークン」を得て、{@link RemoteDbConnection} /
 * {@link remoteIdentity} に写す。ここに現れるのは **どの DB を開くか** だけで、
 * DEK・PRF 出力・本文は一切通らない（E2E, docs/RESEARCH.md §6）。
 *
 * 設計上の要点:
 * - **セッション JWT はメモリだけ**に持つ（localStorage / sessionStorage / Cookie に
 *   書かない）。リロードで消えるが、再ログインは passkey の生体認証 1 回なので UX 劣化は小。
 * - **ログインの `get()` は 1 回**。同じ assertion 取得で PRF も評価する
 *   （`extensions.prf.eval` を載せる）。サーバは未署名の `clientExtensionResults` を
 *   読まない・受け取らない（apps/api の routes/auth.ts）ので、PRF 出力は wire に出さない。
 * - WebAuthn のブラウザ呼び出しは #104 の adapter（{@link CredentialsApi}）を再利用し、
 *   テストは PublicKeyCredential 形状の fake を注入する。
 */
import * as v from "valibot";
import type { RemoteDbConnection } from "@zakki/core/identity/remote.ts";
import { isConnectionExpiring, remoteIdentity } from "@zakki/core/identity/remote.ts";
import type { Identity } from "@zakki/core/identity/types.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { ApiRequestError, request } from "@zakki/web/client/api/client.ts";
import type { CredentialsApi } from "@zakki/web/client/db/passkey.ts";
import { browserCredentials, PRF_SALT, readPrfOutput } from "@zakki/web/client/db/passkey.ts";

// --- base64url（WebAuthn の wire 表現） -------------------------------------
//
// sodium.ready を待たずに使えるよう、ブラウザ標準の atob / btoa で書く
// （ログインは DB オープン・暗号初期化より前に走る）。

function toBytes(src: ArrayBuffer): Uint8Array {
  return new Uint8Array(src);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (ch) =>
    ch.charCodeAt(0),
  );
}

// --- サーバ応答のスキーマ ---------------------------------------------------
//
// HTTP JSON は untyped の境界なので valibot で検証してから型を名乗る（issue #48 の流儀）。
// 未知のキーは無視する（サーバが将来足すフィールドで壊れない）。

/** register/verify・login/verify が返すセッション（#100） */
const SessionSchema = v.object({
  accountId: v.string(),
  token: v.string(),
  expiresAt: v.number(),
});

/** `GET /me/db` の応答（#101） */
const DbConnectionSchema = v.object({
  dbUrl: v.string(),
  token: v.string(),
  expiresAt: v.number(),
});

/**
 * WebAuthn ceremony options（@simplewebauthn/server が返す JSON）。
 * クライアントが実際に使うフィールドだけを検証し、残りは passthrough で
 * `credentials.create/get` へ渡す（サーバが options を足しても壊れない）。
 */
const CreationOptionsSchema = v.looseObject({
  challenge: v.string(),
  rp: v.looseObject({ id: v.optional(v.string()), name: v.string() }),
  user: v.looseObject({ id: v.string(), name: v.string(), displayName: v.string() }),
  pubKeyCredParams: v.array(v.looseObject({ type: v.literal("public-key"), alg: v.number() })),
  timeout: v.optional(v.number()),
  authenticatorSelection: v.optional(
    v.looseObject({
      residentKey: v.optional(v.string()),
      userVerification: v.optional(v.string()),
    }),
  ),
});

const RequestOptionsSchema = v.looseObject({
  challenge: v.string(),
  rpId: v.optional(v.string()),
  timeout: v.optional(v.number()),
  userVerification: v.optional(v.string()),
});

/** メモリ保持のセッション。永続化しない */
export interface ControlPlaneSession {
  readonly accountId: string;
  readonly token: string;
  /** epoch 秒 */
  readonly expiresAt: number;
}

export interface ControlPlaneOptions {
  /** apps/api の base URL（末尾スラッシュ無し。例 https://api.zakki.example.com） */
  readonly baseUrl: string;
  /** WebAuthn adapter（#104）。未対応環境では null で、リモート構成は使えない */
  readonly credentials: CredentialsApi;
  /** 省略時はグローバル fetch。テストは apps/api の Hono `app.request` を注入する */
  readonly fetchFn?: FetchLike;
  /** 現在時刻（ms）。トークン失効の先回り判定に使う。テストが固定する */
  readonly now?: () => number;
}

export interface ControlPlaneClient {
  /** 現在のセッション（未ログインなら null）。メモリのみ */
  readonly session: () => ControlPlaneSession | null;
  /**
   * パスキーを新規登録してセッションを得る（会員登録）。
   * 返す credentialId は、そのまま #104 の `savePasskeyEnvelope` に渡して
   * 同じパスキーの PRF で DEK 封筒を作るためのもの。
   */
  readonly register: (label?: string) => Promise<{
    session: ControlPlaneSession;
    credentialId: string;
  }>;
  /**
   * パスキーでログインする。**同じ 1 回の `get()`** で assertion と PRF 出力の
   * 両方を得る（PRF 非対応の認証器では prfOutput が null になるだけでログインは成功）。
   */
  readonly login: () => Promise<{
    session: ControlPlaneSession;
    prfOutput: Uint8Array | null;
  }>;
  /** `GET /me/db`。失効が近いときだけ取り直す（それ以外はキャッシュを返す） */
  readonly connect: () => Promise<RemoteDbConnection>;
  /** 接続情報を Identity（RemoteIdentity）へ写して返す */
  readonly identity: () => Promise<Identity>;
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

/** 認証器レスポンスの必要面（`Credential` 基底型には無いので構造で判定する） */
interface AttestationLike {
  readonly clientDataJSON: ArrayBuffer;
  readonly attestationObject: ArrayBuffer;
  readonly getTransports?: () => string[];
}

interface AssertionLike {
  readonly clientDataJSON: ArrayBuffer;
  readonly authenticatorData: ArrayBuffer;
  readonly signature: ArrayBuffer;
  readonly userHandle: ArrayBuffer | null;
}

function responseOf(credential: Credential | null): unknown {
  if (credential === null || !("response" in credential)) return null;
  return credential.response;
}

function isAttestation(value: unknown): value is AttestationLike {
  if (typeof value !== "object" || value === null) return false;
  return (
    "clientDataJSON" in value &&
    value.clientDataJSON instanceof ArrayBuffer &&
    "attestationObject" in value &&
    value.attestationObject instanceof ArrayBuffer
  );
}

function isAssertion(value: unknown): value is AssertionLike {
  if (typeof value !== "object" || value === null) return false;
  return (
    "clientDataJSON" in value &&
    value.clientDataJSON instanceof ArrayBuffer &&
    "authenticatorData" in value &&
    value.authenticatorData instanceof ArrayBuffer &&
    "signature" in value &&
    value.signature instanceof ArrayBuffer
  );
}

/** ログイン・登録の失敗（キャンセル・応答不正）。メッセージは UI 表示用で秘密を含まない */
export class ControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

/**
 * 認証器の応答 → サーバへ送る JSON。
 * **`clientExtensionResults` は載せない**: そこには PRF 出力が入り得るのに、サーバは
 * 未署名の値として読まない（apps/api 側で空に潰す）ため、送る理由が無い。
 */
function attestationJson(credential: Credential, response: AttestationLike): object {
  const transports = response.getTransports?.();
  return {
    id: credential.id,
    rawId: credential.id,
    type: "public-key",
    response: {
      clientDataJSON: encodeBase64Url(toBytes(response.clientDataJSON)),
      attestationObject: encodeBase64Url(toBytes(response.attestationObject)),
      ...(transports === undefined ? {} : { transports }),
    },
  };
}

function assertionJson(credential: Credential, response: AssertionLike): object {
  const userHandle = response.userHandle;
  return {
    id: credential.id,
    rawId: credential.id,
    type: "public-key",
    response: {
      clientDataJSON: encodeBase64Url(toBytes(response.clientDataJSON)),
      authenticatorData: encodeBase64Url(toBytes(response.authenticatorData)),
      signature: encodeBase64Url(toBytes(response.signature)),
      ...(userHandle === null ? {} : { userHandle: encodeBase64Url(toBytes(userHandle)) }),
    },
  };
}

/** WebAuthn の userVerification / residentKey は文字列列挙。未知値はブラウザ既定に任せる */
function verification(value: string | undefined): UserVerificationRequirement | undefined {
  return value === "required" || value === "preferred" || value === "discouraged"
    ? value
    : undefined;
}

function residentKey(value: string | undefined): ResidentKeyRequirement | undefined {
  return value === "required" || value === "preferred" || value === "discouraged"
    ? value
    : undefined;
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
      throw new ControlPlaneError("コントロールプレーンにログインしていません");
    }
    return session;
  };

  const register = async (label?: string) => {
    const ceremony = await requestJson(
      fetchFn,
      `${base}/auth/register/options`,
      CreationOptionsSchema,
      { method: "POST", body: JSON.stringify(label === undefined ? {} : { label }) },
    );
    const credential = await options.credentials.create({
      publicKey: {
        challenge: decodeBase64Url(ceremony.challenge),
        rp: {
          ...(ceremony.rp.id === undefined ? {} : { id: ceremony.rp.id }),
          name: ceremony.rp.name,
        },
        user: {
          id: decodeBase64Url(ceremony.user.id),
          name: ceremony.user.name,
          displayName: ceremony.user.displayName,
        },
        pubKeyCredParams: ceremony.pubKeyCredParams.map((p) => ({ type: p.type, alg: p.alg })),
        ...(ceremony.timeout === undefined ? {} : { timeout: ceremony.timeout }),
        authenticatorSelection: {
          residentKey: residentKey(ceremony.authenticatorSelection?.residentKey) ?? "required",
          requireResidentKey: true,
          userVerification:
            verification(ceremony.authenticatorSelection?.userVerification) ?? "required",
        },
        // PRF は登録時は有効化のみ（評価はログインの get で行う）
        extensions: { prf: {} },
      },
    });
    const response = responseOf(credential);
    if (credential === null || !isAttestation(response)) {
      throw new ControlPlaneError("パスキーの作成に失敗しました（キャンセル・未対応）");
    }
    session = await requestJson(fetchFn, `${base}/auth/register/verify`, SessionSchema, {
      method: "POST",
      body: JSON.stringify(attestationJson(credential, response)),
    });
    connection = null;
    return { session, credentialId: credential.id };
  };

  const login = async () => {
    const ceremony = await requestJson(
      fetchFn,
      `${base}/auth/login/options`,
      RequestOptionsSchema,
      { method: "POST", body: "{}" },
    );
    // ここが「1 回に畳む」点: 同じ get で assertion（サーバ検証用）と PRF 出力
    // （封筒アンロック用）の両方が返る。生体認証は 1 回で済む
    const credential = await options.credentials.get({
      publicKey: {
        challenge: decodeBase64Url(ceremony.challenge),
        ...(ceremony.rpId === undefined ? {} : { rpId: ceremony.rpId }),
        ...(ceremony.timeout === undefined ? {} : { timeout: ceremony.timeout }),
        userVerification: verification(ceremony.userVerification) ?? "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    const response = responseOf(credential);
    if (credential === null || !isAssertion(response)) {
      throw new ControlPlaneError("パスキーでの認証に失敗しました（キャンセル・未対応）");
    }
    session = await requestJson(fetchFn, `${base}/auth/login/verify`, SessionSchema, {
      method: "POST",
      body: JSON.stringify(assertionJson(credential, response)),
    });
    connection = null;
    // PRF 未対応の認証器でもログイン自体は成立させる（封筒はパスフレーズで開く）
    let prfOutput: Uint8Array | null;
    try {
      prfOutput = readPrfOutput(credential);
    } catch {
      prfOutput = null;
    }
    return { session, prfOutput };
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

  return {
    session: () => session,
    register,
    login,
    connect,
    identity: async () => remoteIdentity(await connect()),
    authorizedFetch,
  };
}

// --- 構成の選択（設定ベース） ----------------------------------------------

/** `GET /api/config`（中継サーバが自分の設定から返す）。秘密は含まない */
const ClientConfigSchema = v.object({ controlPlaneUrl: v.nullable(v.string()) });

/**
 * ログイン済みのリモート構成一式。`fetchFn` をそのまま `bootstrapClientDb` に渡すと、
 * 封筒取得・replication が「自分の DB」へ向く（中継の宛先はサーバが解決する）。
 */
export interface RemoteSession {
  readonly identity: Identity;
  readonly fetchFn: FetchLike;
  /** ログインの get で一緒に得た PRF 出力（PRF 非対応なら null） */
  readonly prfOutput: Uint8Array | null;
  readonly client: ControlPlaneClient;
}

/**
 * 起動時の構成選択（issue #105）。**設定ベース**で、判断材料は中継サーバが返す
 * `controlPlaneUrl` だけ:
 * - 未設定 → null（従来の単一ユーザ構成。呼び出し側は何も変えずに起動する）
 * - 設定あり → パスキーでログインし、`GET /me/db` の接続情報を RemoteIdentity に写す
 *
 * ログインできない（未登録・キャンセル・WebAuthn 非対応）場合も null を返す。
 * 呼び出し側は従来経路で起動し、同期は始まらない（中継サーバが 401 を返すため、
 * 暗号文が別アカウントの DB へ紛れ込むことはない）。
 */
export async function resolveRemoteSession(
  options: { fetchFn?: FetchLike; credentials?: CredentialsApi | null } = {},
): Promise<RemoteSession | null> {
  const raw = await request<unknown>("/config", undefined, options.fetchFn).catch(() => null);
  const parsed = v.safeParse(ClientConfigSchema, raw);
  const baseUrl = parsed.success ? parsed.output.controlPlaneUrl : null;
  if (baseUrl === null) return null;

  const credentials =
    options.credentials === undefined ? browserCredentials() : options.credentials;
  if (credentials === null) {
    console.warn("zakki-control-plane: WebAuthn 非対応のためリモート構成を使えません");
    return null;
  }
  const client = createControlPlaneClient({
    baseUrl,
    credentials,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
  });
  try {
    const { prfOutput } = await client.login();
    return {
      identity: await client.identity(),
      fetchFn: client.authorizedFetch,
      prfOutput,
      client,
    };
  } catch (err: unknown) {
    // 未登録・キャンセル・オフライン。秘密は載せずに種別だけ残す
    console.warn(
      `zakki-control-plane: ログインできませんでした（ローカルのみで起動）: ${err instanceof Error ? err.name : "unknown"}`,
    );
    return null;
  }
}
