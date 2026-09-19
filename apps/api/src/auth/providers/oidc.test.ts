import { beforeEach, describe, expect, test } from "bun:test";
import { createOidcProvider } from "@zakki/api/auth/providers/oidc.ts";
import type { IdentityProvider } from "@zakki/api/auth/providers/types.ts";
import {
  createFakeIdp,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_ISSUER,
  type FakeIdp,
} from "@zakki/api/auth/test-oidc.ts";

/**
 * 汎用 OIDC アダプタの検証。相手は fake IdP（test-oidc.ts）で、HTTP の面だけを
 * 置き換える。PKCE・nonce・id_token の検証は oauth4webapi の実体を通す。
 */

const REDIRECT_URI = "https://api.zakki.test/auth/oidc/test/callback";

let idp: FakeIdp;
let provider: IdentityProvider;

beforeEach(async () => {
  idp = await createFakeIdp();
  provider = createOidcProvider({
    id: "test",
    displayName: "Test IdP",
    issuer: FAKE_ISSUER,
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    fetch: idp.fetch,
  });
});

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** start → 同意 → コールバック URL までを組み立てる */
async function consent(params: {
  state: string;
  verifier: string;
  nonce: string;
  subject: string;
  email?: string;
  idTokenNonce?: string;
}): Promise<URL> {
  const code = idp.issueCode({
    codeChallenge: await challengeOf(params.verifier),
    nonce: params.idTokenNonce ?? params.nonce,
    subject: params.subject,
    ...(params.email === undefined ? {} : { email: params.email }),
  });
  const callback = new URL(REDIRECT_URI);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", params.state);
  callback.searchParams.set("iss", FAKE_ISSUER);
  return callback;
}

const VERIFIER = "v".repeat(64);

describe("authorizationUrl", () => {
  test("discovery の認可エンドポイントに PKCE / state / nonce / scope / redirect_uri を載せる", async () => {
    const url = await provider.authorizationUrl({
      state: "st-1",
      codeChallenge: "cc-1",
      nonce: "n-1",
    });
    expect(`${url.origin}${url.pathname}`).toBe(`${FAKE_ISSUER}/authorize`);
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(FAKE_CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(q.get("state")).toBe("st-1");
    expect(q.get("nonce")).toBe("n-1");
    expect(q.get("code_challenge")).toBe("cc-1");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email"]));
  });

  test("discovery はインスタンス内で 1 回だけ取得する", async () => {
    await provider.authorizationUrl({ state: "a", codeChallenge: "c", nonce: "n" });
    await provider.authorizationUrl({ state: "b", codeChallenge: "c", nonce: "n" });
    expect(idp.discoveryHits()).toBe(1);
  });
});

describe("exchange", () => {
  test("code を交換し、id_token の sub / email を返す", async () => {
    const callbackUrl = await consent({
      state: "st",
      verifier: VERIFIER,
      nonce: "nonce-1",
      subject: "google-sub-1",
      email: "me@example.com",
    });
    const result = await provider.exchange({
      callbackUrl,
      expectedState: "st",
      codeVerifier: VERIFIER,
      nonce: "nonce-1",
    });
    expect(result._unsafeUnwrap()).toEqual({ subject: "google-sub-1", email: "me@example.com" });
  });

  test("email を返さないプロバイダでは email が null", async () => {
    const callbackUrl = await consent({
      state: "st",
      verifier: VERIFIER,
      nonce: "n",
      subject: "sub-no-mail",
    });
    const result = await provider.exchange({
      callbackUrl,
      expectedState: "st",
      codeVerifier: VERIFIER,
      nonce: "n",
    });
    expect(result._unsafeUnwrap()).toEqual({ subject: "sub-no-mail", email: null });
  });

  test("id_token の nonce が期待と違えば provider エラー", async () => {
    const callbackUrl = await consent({
      state: "st",
      verifier: VERIFIER,
      nonce: "expected",
      idTokenNonce: "other",
      subject: "s",
    });
    const result = await provider.exchange({
      callbackUrl,
      expectedState: "st",
      codeVerifier: VERIFIER,
      nonce: "expected",
    });
    expect(result._unsafeUnwrapErr().kind).toBe("provider");
  });

  test("state がコールバックと食い違えば provider エラー", async () => {
    const callbackUrl = await consent({
      state: "st",
      verifier: VERIFIER,
      nonce: "n",
      subject: "s",
    });
    const result = await provider.exchange({
      callbackUrl,
      expectedState: "different",
      codeVerifier: VERIFIER,
      nonce: "n",
    });
    expect(result._unsafeUnwrapErr().kind).toBe("provider");
  });

  test("token エンドポイントが 4xx なら provider エラー", async () => {
    const callbackUrl = await consent({
      state: "st",
      verifier: VERIFIER,
      nonce: "n",
      subject: "s",
    });
    idp.failToken = true;
    const result = await provider.exchange({
      callbackUrl,
      expectedState: "st",
      codeVerifier: VERIFIER,
      nonce: "n",
    });
    expect(result._unsafeUnwrapErr().kind).toBe("provider");
  });

  test("PKCE verifier が合わなければ provider エラー", async () => {
    const callbackUrl = await consent({
      state: "st",
      verifier: VERIFIER,
      nonce: "n",
      subject: "s",
    });
    const result = await provider.exchange({
      callbackUrl,
      expectedState: "st",
      codeVerifier: "w".repeat(64),
      nonce: "n",
    });
    expect(result._unsafeUnwrapErr().kind).toBe("provider");
  });

  test("利用者が同意を拒否した（error=access_denied）なら denied", async () => {
    const callbackUrl = new URL(REDIRECT_URI);
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("state", "st");
    const result = await provider.exchange({
      callbackUrl,
      expectedState: "st",
      codeVerifier: VERIFIER,
      nonce: "n",
    });
    expect(result._unsafeUnwrapErr()).toEqual({ kind: "denied" });
  });
});
