import { Hono } from "hono";
import type { FetchLike } from "@zakki/api/auth/providers/oidc.ts";

/**
 * テスト用の fake OIDC プロバイダ（テスト専用。本番コードから import しない）。
 *
 * Google はローカルで再現できないので、**プロトコルレベル**で置き換える
 * （~/.references/policy/testing.md）: discovery・JWKS・token エンドポイントを HTTP で
 * 実装し、アダプタ（oauth4webapi）には `fetch` を差し替えて渡す。アダプタのメソッドは
 * mock しない。id_token は WebCrypto の RSA 鍵で本物の RS256 署名を付ける。
 *
 * 認可エンドポイント（同意画面）は持たない: テストは start の Location から
 * state / nonce / code_challenge を読み、{@link FakeIdp.issueCode} で「同意した結果の
 * code」を直接作ってコールバックへ渡す。
 */

export const FAKE_ISSUER = "https://idp.test";
export const FAKE_CLIENT_ID = "zakki-client";
export const FAKE_CLIENT_SECRET = "zakki-secret";

export interface IssueCodeParams {
  /** start が認可 URL に載せた code_challenge（token 要求の verifier と照合する） */
  readonly codeChallenge: string;
  /** id_token に焼く nonce（start が認可 URL に載せたもの） */
  readonly nonce: string;
  readonly subject: string;
  readonly email?: string;
}

export interface FakeIdp {
  readonly issuer: string;
  /** アダプタへ渡す fetch。`https://idp.test/*` をこの fake へ振り、それ以外は失敗させる */
  readonly fetch: FetchLike;
  /** 利用者が同意した体で code を発行する */
  readonly issueCode: (params: IssueCodeParams) => string;
  /** discovery 文書の取得回数（キャッシュの検証用） */
  readonly discoveryHits: () => number;
  /** true にすると token エンドポイントが 400 invalid_grant を返す */
  failToken: boolean;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function createFakeIdp(): Promise<FakeIdp> {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const kid = "test-key";

  async function signIdToken(claims: Record<string, unknown>): Promise<string> {
    const input = `${base64UrlJson({ alg: "RS256", typ: "JWT", kid })}.${base64UrlJson(claims)}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${base64Url(new Uint8Array(signature))}`;
  }

  const codes = new Map<string, IssueCodeParams>();
  let discoveryHits = 0;

  const app = new Hono();
  app.get("/.well-known/openid-configuration", (c) => {
    discoveryHits += 1;
    return c.json({
      issuer: FAKE_ISSUER,
      authorization_endpoint: `${FAKE_ISSUER}/authorize`,
      token_endpoint: `${FAKE_ISSUER}/token`,
      jwks_uri: `${FAKE_ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
  });
  app.get("/jwks", (c) => c.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }));
  app.post("/token", async (c) => {
    if (idp.failToken) return c.json({ error: "invalid_grant" }, 400);
    const form = await c.req.parseBody();
    if (form["client_id"] !== FAKE_CLIENT_ID || form["client_secret"] !== FAKE_CLIENT_SECRET) {
      return c.json({ error: "invalid_client" }, 401);
    }
    const code = typeof form["code"] === "string" ? form["code"] : "";
    const grant = codes.get(code);
    codes.delete(code);
    const verifier = typeof form["code_verifier"] === "string" ? form["code_verifier"] : "";
    if (grant === undefined || (await s256(verifier)) !== grant.codeChallenge) {
      return c.json({ error: "invalid_grant" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await signIdToken({
      iss: FAKE_ISSUER,
      aud: FAKE_CLIENT_ID,
      sub: grant.subject,
      iat: now,
      exp: now + 3600,
      nonce: grant.nonce,
      ...(grant.email === undefined ? {} : { email: grant.email, email_verified: true }),
    });
    return c.json({
      access_token: `at-${code}`,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
    });
  });

  const idp: FakeIdp = {
    issuer: FAKE_ISSUER,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.startsWith(`${FAKE_ISSUER}/`)) {
        throw new Error(`fake IdP の外への fetch: ${request.url}`);
      }
      return app.fetch(request);
    },
    issueCode: (params) => {
      const code = crypto.randomUUID();
      codes.set(code, params);
      return code;
    },
    discoveryHits: () => discoveryHits,
    failToken: false,
  };
  return idp;
}
