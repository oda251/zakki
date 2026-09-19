import { expect } from "bun:test";
import { createOidcProvider } from "@zakki/api/auth/providers/oidc.ts";
import type { IdentityProvider } from "@zakki/api/auth/providers/types.ts";
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_ISSUER,
  type FakeIdp,
} from "@zakki/api/auth/test-oidc.ts";

/**
 * OIDC ログインを本物の経路（start → 同意 → callback → exchange）で通すテスト用ヘルパ
 * （テスト専用。本番コードから import しない）。セッションが要るだけのテスト
 * （routes/me.test.ts・apps/web の結合テスト）もこれでログインする。
 */

/** テストでのコントロールプレーンの origin（redirect_uri の組み立てに使う） */
export const TEST_API_ORIGIN = "https://control.test";
/** テストでの SPA の origin（CORS とログイン後の戻り先） */
export const TEST_APP_ORIGIN = "https://zakki.test";

/** fetch ハンドラだけを持つもの（Hono app を想定） */
export interface FetchHandler {
  fetch: (request: Request) => Response | Promise<Response>;
}

/** fake IdP を向いた "google" プロバイダ。本番の合成点と同じく汎用 OIDC アダプタで作る */
export function createTestGoogleProvider(idp: FakeIdp): IdentityProvider {
  return createOidcProvider({
    id: "google",
    displayName: "Google",
    issuer: FAKE_ISSUER,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    redirectUri: `${TEST_API_ORIGIN}/auth/oidc/google/callback`,
    fetch: idp.fetch,
  });
}

export interface StartedLogin {
  readonly response: Response;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

/** `GET /auth/oidc/:provider/start` を叩き、認可 URL から state / nonce / challenge を読む */
export async function startLogin(app: FetchHandler, provider = "google"): Promise<StartedLogin> {
  const response = await app.fetch(new Request(`${TEST_API_ORIGIN}/auth/oidc/${provider}/start`));
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return {
    response,
    state: location.searchParams.get("state") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
    codeChallenge: location.searchParams.get("code_challenge") ?? "",
  };
}

/** 同意した体でコールバックを叩く。戻り値はコールバックの応答（302） */
export async function callback(
  app: FetchHandler,
  idp: FakeIdp,
  started: StartedLogin,
  identity: { subject: string; email?: string },
  provider = "google",
): Promise<Response> {
  const code = idp.issueCode({
    codeChallenge: started.codeChallenge,
    nonce: started.nonce,
    subject: identity.subject,
    ...(identity.email === undefined ? {} : { email: identity.email }),
  });
  const url = new URL(`${TEST_API_ORIGIN}/auth/oidc/${provider}/callback`);
  url.searchParams.set("code", code);
  url.searchParams.set("state", started.state);
  url.searchParams.set("iss", FAKE_ISSUER);
  return app.fetch(new Request(url));
}

/** コールバックの Location（`APP_ORIGIN/#login=<code>`）から handoff code を取り出す */
export function handoffCodeOf(response: Response): string {
  const location = new URL(response.headers.get("location") ?? "");
  return new URLSearchParams(location.hash.slice(1)).get("login") ?? "";
}

/** `POST /auth/login/exchange` */
export async function exchange(app: FetchHandler, code: unknown): Promise<Response> {
  return app.fetch(
    new Request(`${TEST_API_ORIGIN}/auth/login/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
}

export interface TestSession {
  readonly accountId: string;
  readonly token: string;
  readonly expiresAt: number;
}

function isTestSession(value: unknown): value is TestSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "accountId" in value &&
    typeof value.accountId === "string" &&
    "token" in value &&
    typeof value.token === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number"
  );
}

/** start → 同意 → callback → exchange を通してセッションを得る */
export async function loginWithIdp(
  app: FetchHandler,
  idp: FakeIdp,
  identity: { subject: string; email?: string },
): Promise<TestSession> {
  const started = await startLogin(app);
  const cb = await callback(app, idp, started, identity);
  expect(cb.status).toBe(302);
  const res = await exchange(app, handoffCodeOf(cb));
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (!isTestSession(body)) throw new Error(`セッションの形ではない: ${JSON.stringify(body)}`);
  return body;
}
