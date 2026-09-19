import {
  calculatePKCECodeChallenge,
  generateRandomCodeVerifier,
  generateRandomNonce,
  generateRandomState,
} from "oauth4webapi";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import * as v from "valibot";
import type { ApiEnv, SessionEnv } from "@zakki/api/context.ts";
import type { ExternalIdentity, IdentityProvider } from "@zakki/api/auth/providers/types.ts";
import { consumeLoginHandoff, issueLoginHandoff } from "@zakki/api/auth/handoffs.ts";
import { consumeOidcState, issueOidcState } from "@zakki/api/auth/oidc-states.ts";
import {
  issueSession,
  requireActiveSession,
  requireSession,
  revokeSessions,
} from "@zakki/api/auth/session.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accountIdentities, accounts } from "@zakki/api/db/schema.ts";
import type { AppDeps, AuthConfig } from "@zakki/api/deps.ts";
import { parseBody } from "@zakki/api/parse.ts";

/**
 * OIDC（Authorization Code + PKCE）によるログインとセッション発行
 * （docs/tmp/oidc-google-login.md）、および全端末ログアウト（issue #117）。
 *
 * ルートはプロバイダの詳細を知らない。知っているのは {@link IdentityProvider} という
 * ポートだけで、Google かどうか・OIDC か素の OAuth2 かはアダプタ側
 * （auth/providers/oidc.ts）に閉じる。state / PKCE verifier / nonce の発行・消費は
 * auth/oidc-states.ts、ログイン handoff コードは auth/handoffs.ts に分離してある。
 *
 * サーバが扱うのはプロバイダが保証する `(provider, subject)` の同定だけで、
 * E2E の鍵材料には一切触れない。
 */

/** 新規アカウントのセッション世代（issue #117）。schema の default と同じ値 */
const INITIAL_SESSION_EPOCH = 0;

/** `POST /login/exchange` のボディ */
const ExchangeBodySchema = v.object({ code: v.string() });

/** SPA へ戻す fragment。ログイン成功時は `login`、失敗時は `login_error` */
function loginRedirect(appOrigin: string, key: "login" | "login_error", value: string): string {
  return `${appOrigin}/#${key}=${value}`;
}

/**
 * 検証済みのセッションを JSON で返す共通形。
 * `sessionEpoch` は台帳の現在値をそのまま焼き込む（issue #117）。
 */
async function sessionResponse(
  accountId: string,
  config: AuthConfig,
  now: number,
  sessionEpoch: number,
) {
  const session = await issueSession(accountId, config.sessionSecret, now, sessionEpoch);
  return { accountId, token: session.token, expiresAt: session.expiresAt };
}

/** ログイン時にトークンへ焼く世代を台帳から引く（アカウントが無ければ null） */
async function currentSessionEpoch(db: ControlDb, accountId: string): Promise<number | null> {
  const rows = await db
    .select({ sessionEpoch: accounts.sessionEpoch })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return rows[0]?.sessionEpoch ?? null;
}

/** `(provider, subject)` で identity を引く（無ければ null） */
async function findAccountByIdentity(
  db: ControlDb,
  providerId: string,
  subject: string,
): Promise<string | null> {
  const rows = await db
    .select({ accountId: accountIdentities.accountId })
    .from(accountIdentities)
    .where(and(eq(accountIdentities.provider, providerId), eq(accountIdentities.subject, subject)))
    .limit(1);
  return rows[0]?.accountId ?? null;
}

/**
 * `(provider, subject)` の identity から accountId を引く。無ければ account と
 * identity を作る。
 *
 * accounts と account_identities は「片方だけ在る」状態を作らない（孤児アカウント =
 * 二度とログインできない行）ため 1 バッチで書く。同時に来た初回ログイン同士は
 * `(provider, subject)` の主キー衝突でどちらかのバッチが失敗する（batch はアトミック
 * なので accounts 側も一緒に巻き戻る）——その場合は作成をあきらめ、相手が書いた
 * identity を読み直す（もう一方の account が確定しているはず）。
 */
async function findOrCreateAccount(
  db: ControlDb,
  providerId: string,
  identity: ExternalIdentity,
  now: number,
): Promise<string> {
  const existing = await findAccountByIdentity(db, providerId, identity.subject);
  if (existing !== null) return existing;

  const accountId = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  try {
    await db.batch([
      db.insert(accounts).values({ id: accountId, sessionEpoch: INITIAL_SESSION_EPOCH, createdAt }),
      db.insert(accountIdentities).values({
        provider: providerId,
        subject: identity.subject,
        accountId,
        email: identity.email,
        createdAt,
      }),
    ]);
    return accountId;
  } catch {
    // 主キー衝突（同時に来た初回ログイン）。相手が確定させた identity を読み直す
    const retried = await findAccountByIdentity(db, providerId, identity.subject);
    if (retried === null) throw new Error("account identity の作成に失敗しました");
    return retried;
  }
}

export function authRoutes(deps: AppDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { db, auth, providers } = deps;

  function findProvider(id: string): IdentityProvider | undefined {
    return providers.find((provider) => provider.id === id);
  }

  // --- プロバイダ一覧 -------------------------------------------------------

  app.get("/providers", (c) => {
    return c.json({
      providers: providers.map((provider) => ({ id: provider.id, name: provider.displayName })),
    });
  });

  // --- OIDC 開始 -------------------------------------------------------------

  app.get("/oidc/:provider/start", async (c) => {
    const provider = findProvider(c.req.param("provider"));
    if (provider === undefined) return c.json({ error: "未知のプロバイダです" }, 404);

    const state = generateRandomState();
    const nonce = generateRandomNonce();
    const codeVerifier = generateRandomCodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const now = Date.now();
    const issued = await issueOidcState(db, {
      state,
      provider: provider.id,
      codeVerifier,
      nonce,
      now,
    });
    if (!issued)
      return c.json({ error: "混み合っています。しばらくしてからやり直してください" }, 429);

    const url = await provider.authorizationUrl({ state, codeChallenge, nonce });
    return c.redirect(url.toString(), 302);
  });

  // --- OIDC コールバック -----------------------------------------------------

  app.get("/oidc/:provider/callback", async (c) => {
    const providerId = c.req.param("provider");
    const callbackUrl = new URL(c.req.url);
    const state = callbackUrl.searchParams.get("state") ?? "";
    const now = Date.now();

    // state は provider と一緒に消費する: 未知・期限切れ・provider 不一致の
    // どれもここで同じ扱いにする（探索の手掛かりを与えない）
    const consumed = await consumeOidcState(db, { state, provider: providerId, now });
    if (!consumed.ok) {
      return c.redirect(loginRedirect(auth.appOrigin, "login_error", "state"), 302);
    }

    const provider = findProvider(providerId);
    if (provider === undefined) {
      return c.redirect(loginRedirect(auth.appOrigin, "login_error", "provider"), 302);
    }

    const exchanged = await provider.exchange({
      callbackUrl,
      expectedState: state,
      codeVerifier: consumed.codeVerifier,
      nonce: consumed.nonce,
    });
    if (exchanged.isErr()) {
      if (exchanged.error.kind === "denied") {
        return c.redirect(loginRedirect(auth.appOrigin, "login_error", "denied"), 302);
      }
      // 内部メッセージは wire に出さずログへ（他ルートと同じ方針。秘密は含まない）
      console.error(`[auth] oidc exchange failed (${provider.id}):`, exchanged.error.message);
      return c.redirect(loginRedirect(auth.appOrigin, "login_error", "provider"), 302);
    }

    const accountId = await findOrCreateAccount(db, provider.id, exchanged.value, now);
    const code = await issueLoginHandoff(db, { accountId, now });
    return c.redirect(loginRedirect(auth.appOrigin, "login", code), 302);
  });

  // --- ログイン handoff の交換 ------------------------------------------------

  app.post("/login/exchange", async (c) => {
    const body = await parseBody(c.req.raw, ExchangeBodySchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);

    const now = Date.now();
    const accountId = await consumeLoginHandoff(db, { code: body.code, now });
    if (accountId === null) return c.json({ error: "コードが無効または期限切れです" }, 401);

    // 発行するトークンに焼く世代を台帳から読む（issue #117）。行が無い＝退会済み
    const sessionEpoch = await currentSessionEpoch(db, accountId);
    if (sessionEpoch === null) return c.json({ error: "アカウントが見つかりません" }, 401);

    return c.json(await sessionResponse(accountId, auth, now, sessionEpoch));
  });

  // --- セッション確認 -----------------------------------------------------

  // requireSession の到達点。api-3（#101）の保護ルートも同じミドルウェアを使う。
  // `use` のパスは保護対象と同じ `/me` に絞る: `"*"` だと同じインスタンスに後から
  // 未認証ルートを足したときに巻き込む（あるいは登録順に依存する）ため、
  // 「このパスだけが保護対象」を形で示す
  // 退会済みアカウント・ログアウト済み世代の生き残りトークンも弾く（#116 / #117）。
  // 中継サーバ（apps/web）はこの応答で「あなたは誰か」を解決するので、ここが 401 に
  // なることが中継の遮断にそのまま効く
  const session = new Hono<SessionEnv>();
  session.use("/me", requireSession(auth.sessionSecret), requireActiveSession(db));
  session.get("/me", (c) => c.json({ accountId: c.get("accountId") }));

  // --- ログアウト（issue #117） ---------------------------------------------
  //
  // セッション世代を +1 するだけ。そのアカウントが過去に発行した**全ての**トークンが
  // 同時に無効になる（= 全端末ログアウト）。
  session.use("/logout", requireSession(auth.sessionSecret), requireActiveSession(db));
  session.post("/logout", async (c) => {
    await revokeSessions(db, c.get("accountId"));
    // 返すものが無い。以降このトークンは requireActiveSession で 401 になる
    return c.body(null, 204);
  });

  app.route("/", session);

  return app;
}
