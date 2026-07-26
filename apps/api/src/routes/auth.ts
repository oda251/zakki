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
import { and, eq, sql } from "drizzle-orm";
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
 * パスキー（WebAuthn）による登録・ログインとセッション発行（issue #100）、および
 * 既存アカウントへのクレデンシャル追加・一覧・失効（issue #115）。
 *
 * サーバが扱うのは「この鍵ペアの持ち主か」だけで、E2E の鍵材料には触れない。
 * registration options で PRF extension を有効化するのは Phase 8（#103 / #104）の
 * クライアントが同じクレデンシャルから DEK ラップ鍵を導出できるようにするためで、
 * PRF の評価結果はブラウザから出ない（この経路に現れる余地が無い）。
 */

/** 認証器の一覧に出る表示名。RP そのものの名前なので env にしない */
const RP_NAME = "zakki";

/**
 * user.name に載せる accountId の先頭文字数（issue #118）。
 * accountId は UUID なので 8 文字（16^8 通り）あれば self-host 規模の
 * 「表示上どのアカウントか」を分けるのに足り、UUID 全体を OS の UI に晒さずに済む。
 */
const ACCOUNT_HANDLE_CHARS = 8;

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

/** WebAuthn の transports 値（DB / options で共通に使う） */
type Transport = v.InferOutput<typeof TransportSchema>;

/**
 * 空ボディ・`{}` の両方を許す。label は認証器へ渡す userDisplayName になり、
 * 同じ文字列を credentials.display_name にも保存する（issue #118）。
 */
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

/**
 * アカウントのクレデンシャルを一覧する（issue #115）。
 *
 * **public_key を select に含めない**のが要点: 一覧 API・excludeCredentials の
 * どちらも公開鍵を必要としないので、そもそも取り出さないことで「うっかり返す」
 * 経路を型ごと消す。並びは登録順（created_at）で安定させる。
 */
async function listAccountCredentials(db: ControlDb, accountId: string) {
  return db
    .select({
      credentialId: credentials.credentialId,
      displayName: credentials.displayName,
      transports: credentials.transports,
      createdAt: credentials.createdAt,
    })
    .from(credentials)
    .where(eq(credentials.accountId, accountId))
    .orderBy(credentials.createdAt);
}

/** DB の transports（JSON 配列文字列）→ WebAuthn の値。壊れていれば「不明」= 空 */
function parseTransports(raw: string | null): Transport[] {
  if (raw === null) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = v.safeParse(v.array(TransportSchema), decoded);
  return parsed.success ? parsed.output : [];
}

/**
 * WebAuthn の user.name / user.displayName（issue #118）。
 *
 * 仕様の役割分担どおりに**別の値**を入れる:
 * - `name` は「アカウントを見分けるための識別子」。accountId 由来かつ RP ID を
 *   含めることで、複数アカウント・複数 RP が並ぶ OS のパスキー一覧でも一意に読める。
 *   同じアカウントのクレデンシャルではこの値が常に一致する（＝別アカウントに見えない）。
 * - `displayName` は「人間向けの名札」。label 未指定でも入力を強制せず、登録日を
 *   添えた既定値を組み立てる（どの端末でいつ作ったパスキーかを後から思い出せる）。
 */
function userIdentity(params: {
  accountId: string;
  rpId: string;
  label: string | undefined;
  now: number;
}): { userName: string; userDisplayName: string } {
  const date = new Date(params.now).toISOString().slice(0, 10);
  return {
    userName: `${params.accountId.slice(0, ACCOUNT_HANDLE_CHARS)}@${params.rpId}`,
    userDisplayName: params.label ?? `${RP_NAME} (${date})`,
  };
}

/**
 * 登録 ceremony の options を組む（新規アカウント / クレデンシャル追加で共通）。
 *
 * `authenticatorSelection` に **`authenticatorAttachment` を指定しない**のは意図的:
 * 指定すると platform / cross-platform のどちらかに絞られ、機種変更で一番効く
 * hybrid transport（ログイン済み端末から新端末の認証器を QR で使う cross-device
 * authentication）が候補から落ちる。新端末はまだログインできない以上、この経路を
 * 塞がないことが #115 の目的そのもの。
 */
async function buildRegistrationOptions(params: {
  accountId: string;
  auth: AuthConfig;
  label: string | undefined;
  now: number;
  excludeCredentials?: readonly { credentialId: string; transports: string | null }[];
}) {
  const identity = userIdentity({
    accountId: params.accountId,
    rpId: params.auth.rpId,
    label: params.label,
    now: params.now,
  });
  const extensions: PrfRegistrationExtensions = { prf: {} };
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: params.auth.rpId,
    userName: identity.userName,
    userDisplayName: identity.userDisplayName,
    userID: new TextEncoder().encode(params.accountId),
    attestationType: "none",
    // パスワードレスなのでパスキーは discoverable（ID 入力なしでログインできる）
    // かつ UV 必須にする。パスキー単体が唯一の要素なので UV を妥協しない
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: (params.excludeCredentials ?? []).map((row) => ({
      id: row.credentialId,
      transports: parseTransports(row.transports),
    })),
    extensions,
  });
  return { options, displayName: identity.userDisplayName };
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
    const now = Date.now();
    // 新規アカウントなので excludeCredentials は空（このユーザハンドルにはまだ何も無い）
    const { options, displayName } = await buildRegistrationOptions({
      accountId,
      auth,
      label: body.label,
      now,
    });
    await issueChallenge(db, {
      challenge: options.challenge,
      kind: "registration",
      accountId,
      displayName,
      now,
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
        // options で認証器へ渡したのと同じ文字列（issue #118）
        displayName: consumed.displayName,
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

  // --- クレデンシャル管理（issue #115） -------------------------------------
  //
  // 端末の紛失・機種変更に備えて「既存アカウントへパスキーを足す」経路。
  // ここは全て要セッション: 未認証で追加できたらパスキー認証の意味が無い。
  // `/credentials` 自身と配下を別々に宣言するのは、`"*"` を避けて
  // 「保護対象がどのパスか」を形で示す方針（`/me` と同じ）。
  session.use("/credentials", requireSession(auth.sessionSecret), requireLiveAccount(db));
  session.use("/credentials/*", requireSession(auth.sessionSecret), requireLiveAccount(db));

  session.post("/credentials/options", async (c) => {
    const body = await parseBody(c.req.raw, RegisterOptionsSchema);
    if (body === null) return c.json({ error: "invalid body" }, 400);
    const accountId = c.get("accountId");
    const existing = await listAccountCredentials(db, accountId);
    // アカウントは必ず 1 本以上のクレデンシャルを持つ（登録は 1 バッチ・失効は
    // 最後の 1 本を拒否する）ので、0 件 = そのアカウントはもう無い
    if (existing.length === 0) return c.json({ error: "アカウントが見つかりません" }, 404);

    const now = Date.now();
    // **userID は既存 accountId**（新規採番しない）。ここが新規登録との唯一の違いで、
    // 同じユーザハンドルに対する 2 本目として認証器に載る。
    // なお PRF 出力はクレデンシャルごとに異なるため、ここで足したパスキーが DEK 封筒を
    // 開けるようになるのは封筒側を複数対応にしてから（#120）。この経路が担うのは
    // 「そのアカウントとしてログインできる」ところまで
    const { options, displayName } = await buildRegistrationOptions({
      accountId,
      auth,
      label: body.label,
      now,
      // 同じ認証器で二重登録させない（対応する認証器は create をその場で拒否する）
      excludeCredentials: existing,
    });
    await issueChallenge(db, {
      challenge: options.challenge,
      kind: "credential",
      accountId,
      displayName,
      now,
    });
    return c.json(options);
  });

  session.post("/credentials/verify", async (c) => {
    const body = await parseBody(c.req.raw, RegistrationResponseSchema);
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
      kind: "credential",
      now,
    });
    if (!consumed.ok) return c.json({ error: CHALLENGE_ERROR[consumed.reason] }, 401);
    // challenge は「このアカウントに足す」ために発行したもの。別セッションの
    // challenge を横取りして自分のアカウントへ付け替えられないよう突き合わせる
    const accountId = c.get("accountId");
    if (consumed.accountId !== accountId) {
      return c.json({ error: CHALLENGE_ERROR.unknown }, 401);
    }

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
      console.error("[auth] credentials/verify failed:", e);
      return c.json({ error: "登録を検証できませんでした" }, 401);
    }
    if (!verification.verified) return c.json({ error: "登録を検証できませんでした" }, 401);

    const { credential } = verification.registrationInfo;
    // excludeCredentials を無視する認証器（あるいは他アカウントの鍵）への保険。
    // credential_id は主キーなので、ここを抜けても DB が最終的に弾く
    if ((await findCredential(db, credential.id)) !== null) {
      return c.json({ error: "このクレデンシャルは登録済みです" }, 409);
    }
    const createdAt = new Date(now).toISOString();
    // accounts は作らない（既存アカウントへの追加なので credentials だけ）
    await db.insert(credentials).values({
      credentialId: credential.id,
      accountId,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports:
        body.response.transports === undefined ? null : JSON.stringify(body.response.transports),
      displayName: consumed.displayName,
      createdAt,
    });
    return c.json({
      credentialId: credential.id,
      displayName: consumed.displayName,
      createdAt,
    });
  });

  session.get("/credentials", async (c) => {
    const rows = await listAccountCredentials(db, c.get("accountId"));
    // 公開鍵・counter は返さない（UI に要らず、出すだけ攻撃面が増える）
    return c.json({
      credentials: rows.map((row) => ({
        credentialId: row.credentialId,
        displayName: row.displayName,
        createdAt: row.createdAt,
      })),
    });
  });

  session.delete("/credentials/:credentialId", async (c) => {
    const accountId = c.get("accountId");
    const credentialId = c.req.param("credentialId");
    const rows = await listAccountCredentials(db, accountId);
    // 自分のアカウントの一覧にしか当てない。他アカウントのクレデンシャルは
    // 「存在しない」と同じ 404 にする（在否を教えない）
    if (!rows.some((row) => row.credentialId === credentialId)) {
      return c.json({ error: "クレデンシャルが見つかりません" }, 404);
    }
    if (rows.length <= 1) {
      // 最後の 1 本を消すとアカウントに二度と入れない（DB とデータは残るのに
      // 到達不能になる）。取り返しがつかないので API 側で拒否する
      return c.json({ error: "最後のパスキーは失効できません" }, 409);
    }
    // 件数の判定を DELETE 自体の条件に埋める。上の read で判定して削除すると、
    // 2 本のアカウントで別々の鍵への DELETE が同時に走ったとき両方が「2 本ある」を
    // 見て通過し 0 本になる（= アカウントに二度と入れない。#119 未実装のため復旧不能）。
    // SQLite は 1 文を原子的に実行するので、同時実行の 2 本目はここで 0 行になる
    const deleted = await db
      .delete(credentials)
      .where(
        and(
          eq(credentials.credentialId, credentialId),
          eq(credentials.accountId, accountId),
          sql`(select count(*) from ${credentials} where ${credentials.accountId} = ${accountId}) > 1`,
        ),
      )
      .returning({ credentialId: credentials.credentialId });
    if (deleted.length === 0) {
      return c.json({ error: "最後のパスキーは失効できません" }, 409);
    }
    return c.json({ ok: true });
  });

  app.route("/", session);

  return app;
}
