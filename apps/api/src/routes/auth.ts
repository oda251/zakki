import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationExtensionsClientInputs,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import * as v from "valibot";
import type { ApiEnv, SessionEnv } from "@zakki/api/context.ts";
import { consumeChallenge, issueChallenge } from "@zakki/api/auth/challenges.ts";
import { issueSession, requireLiveAccount, requireSession } from "@zakki/api/auth/session.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accounts, credentials } from "@zakki/api/db/schema.ts";
import type { AppDeps, AuthConfig } from "@zakki/api/deps.ts";
import { parseBody } from "@zakki/api/parse.ts";

/**
 * パスキー（WebAuthn）による登録・ログインとセッション発行（issue #100）。
 *
 * サーバが扱うのは「この鍵ペアの持ち主か」だけで、E2E の鍵材料には触れない。
 * registration options で PRF extension を有効化するのは Phase 8（#103 / #104）の
 * クライアントが同じクレデンシャルから DEK ラップ鍵を導出できるようにするためで、
 * PRF の評価結果はブラウザから出ない（この経路に現れる余地が無い）。
 */

/** 認証器の一覧に出る表示名。RP そのものの名前なので env にしない */
const RP_NAME = "zakki";

/**
 * PRF extension（WebAuthn L3）。TypeScript の DOM 型・@simplewebauthn の
 * `AuthenticationExtensionsClientInputs` はまだ prf を知らないので拡張して渡す
 * （generateRegistrationOptions は extensions をそのまま options へ載せる）。
 * 登録時は評価対象を渡さない空オブジェクト = 「この鍵で PRF を使う」の宣言のみ。
 */
interface PrfRegistrationExtensions extends AuthenticationExtensionsClientInputs {
  prf: Record<string, never>;
}

/** WebAuthn の transports。DB には JSON 配列文字列で持つ */
const TransportSchema = v.picklist([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

/** 空ボディ・`{}` の両方を許す（label は認証器の表示名に使うだけで保存しない） */
const RegisterOptionsSchema = v.nullish(
  v.object({ label: v.optional(v.pipe(v.string(), v.maxLength(64))) }),
  () => ({ label: undefined }),
);

/**
 * 認証器のレスポンス。`clientExtensionResults` を受け取らないのは意図的で、
 * あれはブラウザが自己申告する未署名の値（authData の署名対象外）なので信じる
 * 根拠が無い。特に PRF の評価結果はここに載り得るが、サーバは読まない・保存しない
 * （valibot の object は未知のキーを黙って落とすので、クライアントが送っても捨てる）。
 */
const RegistrationResponseSchema = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.string(),
    attestationObject: v.string(),
    transports: v.optional(v.array(TransportSchema)),
  }),
  type: v.literal("public-key"),
});

const AuthenticationResponseSchema = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.string(),
    authenticatorData: v.string(),
    signature: v.string(),
    userHandle: v.optional(v.string()),
  }),
  type: v.literal("public-key"),
});

/** consume の失敗理由 → クライアント向けメッセージ（どちらも 401） */
const CHALLENGE_ERROR = {
  unknown: "challenge が未発行または使用済みです",
  expired: "challenge の有効期限が切れています",
} as const;

/** クレデンシャルを提示された ID で引く（未登録なら null） */
async function findCredential(db: ControlDb, credentialId: string) {
  const rows = await db
    .select()
    .from(credentials)
    .where(eq(credentials.credentialId, credentialId))
    .limit(1);
  return rows[0] ?? null;
}

/** 検証済みのセッションを JSON で返す共通形（register / login で同じ） */
async function sessionResponse(accountId: string, config: AuthConfig, now: number) {
  const session = await issueSession(accountId, config.sessionSecret, now);
  return { accountId, token: session.token, expiresAt: session.expiresAt };
}

export function authRoutes(deps: AppDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { db, auth } = deps;

  // --- 登録 ---------------------------------------------------------------

  app.post("/register/options", async (c) => {
    const body = await parseBody(c.req.raw, RegisterOptionsSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    // account id は options 時点で採番する: WebAuthn の user.id（= 認証器に焼かれる
    // ユーザハンドル）を後から変えられないため。accounts への INSERT は verify が
    // 通ってから行い、それまでは challenge 行の予約として持つ
    const accountId = crypto.randomUUID();
    const extensions: PrfRegistrationExtensions = { prf: {} };
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: auth.rpId,
      userName: body.label ?? RP_NAME,
      userDisplayName: body.label ?? RP_NAME,
      userID: new TextEncoder().encode(accountId),
      attestationType: "none",
      // パスワードレスなのでパスキーは discoverable（ID 入力なしでログインできる）
      // かつ UV 必須にする。パスキー単体が唯一の要素なので UV を妥協しない
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions,
    });
    await issueChallenge(db, {
      challenge: options.challenge,
      kind: "registration",
      accountId,
      now: Date.now(),
    });
    return c.json(options);
  });

  app.post("/register/verify", async (c) => {
    const body = await parseBody(c.req.raw, RegistrationResponseSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);

    let clientData;
    try {
      clientData = decodeClientDataJSON(body.response.clientDataJSON);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const now = Date.now();
    // 先に challenge を消費する（単回使用）。ここで所有権が確定するので、
    // 以降の検証が失敗しても同じ challenge は二度と使えない
    const consumed = await consumeChallenge(db, {
      challenge: clientData.challenge,
      kind: "registration",
      now,
    });
    if (!consumed.ok) return c.json({ error: CHALLENGE_ERROR[consumed.reason] }, 401);
    const accountId = consumed.accountId;
    if (accountId === null) return c.json({ error: CHALLENGE_ERROR.unknown }, 401);

    // 未署名の clientExtensionResults は空で埋める（上記スキーマの注記のとおり読まない）
    const response: RegistrationResponseJSON = { ...body, clientExtensionResults: {} };
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: clientData.challenge,
        expectedOrigin: auth.rpOrigin,
        expectedRPID: auth.rpId,
        requireUserVerification: true,
      });
    } catch (e) {
      // origin / RP ID 不一致・署名不正・未対応 attestation はここで例外になる。
      // 内部メッセージは wire に出さずログへ（apps/web の respond と同じ方針）
      console.error("[auth] register/verify failed:", e);
      return c.json({ error: "登録を検証できませんでした" }, 401);
    }
    if (!verification.verified) return c.json({ error: "登録を検証できませんでした" }, 401);

    const { credential } = verification.registrationInfo;
    if ((await findCredential(db, credential.id)) !== null) {
      return c.json({ error: "このクレデンシャルは登録済みです" }, 409);
    }
    const createdAt = new Date(now).toISOString();
    // accounts と credentials は「片方だけ在る」状態を作らない（孤児アカウント =
    // 二度とログインできない行）ため 1 バッチで書く
    await db.batch([
      db.insert(accounts).values({ id: accountId, createdAt }),
      db.insert(credentials).values({
        credentialId: credential.id,
        accountId,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
        transports:
          body.response.transports === undefined ? null : JSON.stringify(body.response.transports),
        createdAt,
      }),
    ]);
    return c.json(await sessionResponse(accountId, auth, now));
  });

  // --- ログイン -----------------------------------------------------------

  app.post("/login/options", async (c) => {
    // allowCredentials を出さない = discoverable credential でのログイン。
    // 「どの ID が登録済みか」をログイン前に漏らさない利点もある
    const options = await generateAuthenticationOptions({
      rpID: auth.rpId,
      userVerification: "required",
    });
    await issueChallenge(db, {
      challenge: options.challenge,
      kind: "authentication",
      now: Date.now(),
    });
    return c.json(options);
  });

  app.post("/login/verify", async (c) => {
    const body = await parseBody(c.req.raw, AuthenticationResponseSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);

    let clientData;
    try {
      clientData = decodeClientDataJSON(body.response.clientDataJSON);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const now = Date.now();
    const consumed = await consumeChallenge(db, {
      challenge: clientData.challenge,
      kind: "authentication",
      now,
    });
    if (!consumed.ok) return c.json({ error: CHALLENGE_ERROR[consumed.reason] }, 401);

    const stored = await findCredential(db, body.id);
    if (stored === null) return c.json({ error: "未登録のクレデンシャルです" }, 401);

    const response: AuthenticationResponseJSON = { ...body, clientExtensionResults: {} };
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: clientData.challenge,
        expectedOrigin: auth.rpOrigin,
        expectedRPID: auth.rpId,
        requireUserVerification: true,
        credential: {
          id: stored.credentialId,
          publicKey: isoBase64URL.toBuffer(stored.publicKey),
          counter: stored.counter,
        },
      });
    } catch (e) {
      // counter 巻き戻し（クローン検知）・origin 不一致・署名不正はここで例外になる
      console.error("[auth] login/verify failed:", e);
      return c.json({ error: "ログインを検証できませんでした" }, 401);
    }
    if (!verification.verified) return c.json({ error: "ログインを検証できませんでした" }, 401);

    // クローン検知のため counter を進める。0 のまま返す認証器（counter 非対応）も
    // あるので値の増加は強制せず、報告された値をそのまま保存する
    await db
      .update(credentials)
      .set({ counter: verification.authenticationInfo.newCounter })
      .where(eq(credentials.credentialId, stored.credentialId));

    return c.json(await sessionResponse(stored.accountId, auth, now));
  });

  // --- セッション確認 -----------------------------------------------------

  // requireSession の到達点。api-3（#101）の保護ルートも同じミドルウェアを使う。
  // `use` のパスは保護対象と同じ `/me` に絞る: `"*"` だと同じインスタンスに後から
  // 未認証ルートを足したときに巻き込む（あるいは登録順に依存する）ため、
  // 「このパスだけが保護対象」を形で示す
  // 退会済みアカウントの生き残りトークンも弾く（#116）。中継サーバ（apps/web）は
  // この応答で「あなたは誰か」を解決するので、ここが 401 になることが中継の遮断に
  // そのまま効く
  const session = new Hono<SessionEnv>();
  session.use("/me", requireSession(auth.sessionSecret), requireLiveAccount(db));
  session.get("/me", (c) => c.json({ accountId: c.get("accountId") }));
  app.route("/", session);

  return app;
}
