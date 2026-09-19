import type { Result } from "neverthrow";

/**
 * 外部 ID プロバイダのポート（OIDC 移行）。
 *
 * ルート（routes/auth.ts）はこの型だけを知り、どのプロバイダか・OIDC か素の OAuth2 かを
 * 知らない。state / PKCE verifier / nonce の生成と保管はルート側（DB）の責務で、
 * アダプタはそれを受け取って URL を組む・コールバックを検証するだけ——Workers は
 * リクエスト間で状態を持てないので、アダプタを状態なしに保つ。
 */

/** プロバイダが保証する利用者の同定子。アカウントは `(provider id, subject)` で引く */
export interface ExternalIdentity {
  /** プロバイダ内で不変の ID（OIDC の `sub`）。メールは変わりうるので同定に使わない */
  readonly subject: string;
  /** 表示・連絡用。プロバイダが返さなければ null */
  readonly email: string | null;
}

/**
 * コールバック検証の失敗。`denied` は利用者が同意画面で拒否した（`error=access_denied`）、
 * `provider` はそれ以外（state 不一致・トークン交換失敗・id_token 不正など）。
 * message はログ用で wire には出さない。
 */
export type ProviderError =
  | { readonly kind: "denied" }
  | { readonly kind: "provider"; readonly message: string };

export interface AuthorizationRequest {
  readonly state: string;
  /** PKCE S256 の code_challenge */
  readonly codeChallenge: string;
  readonly nonce: string;
}

export interface CallbackInput {
  /** プロバイダから戻ってきたコールバック URL そのもの（クエリに code / state / error） */
  readonly callbackUrl: URL;
  /** start 時に発行して DB に保管していた state */
  readonly expectedState: string;
  readonly codeVerifier: string;
  readonly nonce: string;
}

export interface IdentityProvider {
  /** URL パス・DB に載る識別子（例 "google"）。変えるとアカウントに入れなくなる */
  readonly id: string;
  /** ログインボタンに出す名前 */
  readonly displayName: string;
  /** 認可エンドポイントへの URL を組む */
  readonly authorizationUrl: (request: AuthorizationRequest) => Promise<URL>;
  /** コールバックを検証し、code を交換して利用者を同定する */
  readonly exchange: (input: CallbackInput) => Promise<Result<ExternalIdentity, ProviderError>>;
}
