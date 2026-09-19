import {
  AuthorizationResponseError,
  ClientSecretPost,
  authorizationCodeGrantRequest,
  customFetch,
  discoveryRequest,
  getValidatedIdTokenClaims,
  processAuthorizationCodeResponse,
  processDiscoveryResponse,
  validateAuthResponse,
  type AuthorizationServer,
  type Client,
} from "oauth4webapi";
import { err, ok, type Result } from "neverthrow";
import type {
  AuthorizationRequest,
  CallbackInput,
  ExternalIdentity,
  IdentityProvider,
  ProviderError,
} from "@zakki/api/auth/providers/types.ts";

/**
 * Workers 上で oauth4webapi に渡す fetch の呼び出し面。
 *
 * `typeof fetch` そのものを型に使うとランタイム差（Bun の `typeof fetch` は
 * preconnect 等の余計なオーバーロードを含む）を持ち込むので、渡す分だけに絞って
 * 自前で定義する（テストの fake IdP 側で定義したものとは別。プロダクションはテストへ
 * 依存しない）。
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** {@link createOidcProvider} の設定。プロバイダごとの差異はここに閉じる */
export interface OidcProviderOptions {
  /** URL パス・DB に載る識別子（例 "google"）。types.ts の {@link IdentityProvider.id} に渡る */
  readonly id: string;
  readonly displayName: string;
  /** Issuer Identifier。discovery は `${issuer}/.well-known/openid-configuration` を見に行く */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** 既定は "openid email"（同定に使う sub と、連絡用の email があれば足りる） */
  readonly scope?: string;
  /** 注入用 fetch。省略時はグローバル fetch（本番の合成点はテスト用差し替えを渡さない） */
  readonly fetch?: FetchLike;
}

/**
 * 汎用 OIDC アダプタ（oauth4webapi）。Google もこれに issuer と client を渡して作る。
 *
 * ルート（routes/auth.ts）は {@link IdentityProvider} だけを知り、内部で oauth4webapi の
 * どの関数をどう呼ぶかは知らない。state / PKCE verifier / nonce の生成と保管は呼び出し側
 * （DB）の責務で、ここは「URL を組む」「code を交換して同定する」だけの無状態な薄い層に保つ
 * ——Workers はリクエスト間で状態を持てないため。
 */
export function createOidcProvider(options: OidcProviderOptions): IdentityProvider {
  const issuerUrl = new URL(options.issuer);
  const client: Client = { client_id: options.clientId };
  const clientAuth = ClientSecretPost(options.clientSecret);
  const scope = options.scope ?? "openid email";
  const fetchOption = options.fetch === undefined ? undefined : { [customFetch]: options.fetch };

  /**
   * discovery 文書のキャッシュ。**値ではなく Promise をキャッシュする**のが要点:
   * 値をキャッシュすると同時に来た複数の呼び出しがそれぞれ fetch してしまう。
   * 失敗したらキャッシュを外し、次の呼び出しでまた取り直せるようにする
   * （discovery 文書が一時的に取れないだけで、プロバイダを使えなくし続けない）。
   */
  let discovery: Promise<AuthorizationServer> | undefined;
  function discover(): Promise<AuthorizationServer> {
    if (discovery === undefined) {
      discovery = discoveryRequest(issuerUrl, fetchOption)
        .then((response) => processDiscoveryResponse(issuerUrl, response))
        .catch((error: unknown) => {
          discovery = undefined;
          throw error;
        });
    }
    return discovery;
  }

  return {
    id: options.id,
    displayName: options.displayName,

    async authorizationUrl(request: AuthorizationRequest): Promise<URL> {
      const as = await discover();
      if (as.authorization_endpoint === undefined) {
        throw new Error(`${options.issuer} は認可エンドポイントを公開していません`);
      }
      const url = new URL(as.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", options.redirectUri);
      url.searchParams.set("scope", scope);
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      url.searchParams.set("code_challenge", request.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },

    async exchange(input: CallbackInput): Promise<Result<ExternalIdentity, ProviderError>> {
      // oauth4webapi は state 不一致・トークン交換失敗・id_token 不正等を例外で表す。
      // ポート（types.ts）は exchange から投げない約束なので、ここで一括して受ける。
      try {
        const as = await discover();
        const callbackParams = validateAuthResponse(
          as,
          client,
          input.callbackUrl,
          input.expectedState,
        );
        const tokenResponse = await authorizationCodeGrantRequest(
          as,
          client,
          clientAuth,
          callbackParams,
          options.redirectUri,
          input.codeVerifier,
          fetchOption,
        );
        const tokenResult = await processAuthorizationCodeResponse(as, client, tokenResponse, {
          expectedNonce: input.nonce,
        });
        const claims = getValidatedIdTokenClaims(tokenResult);
        if (claims === undefined) {
          return err({ kind: "provider", message: "token response に id_token がありません" });
        }
        const email = typeof claims.email === "string" ? claims.email : null;
        return ok({ subject: claims.sub, email });
      } catch (error) {
        // 利用者が同意画面で拒否した場合だけ denied。他はメッセージだけログ用に残す
        if (error instanceof AuthorizationResponseError && error.error === "access_denied") {
          return err({ kind: "denied" });
        }
        return err({
          kind: "provider",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
