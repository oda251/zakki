import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";
import type { SessionEnv } from "@zakki/api/context.ts";

/**
 * セッション（issue #100）。
 *
 * Workers はステートレスなのでサーバ側セッションストアを持たず、署名付きの
 * 自己完結トークン（JWT / HS256, SESSION_SECRET）にする。載せるのは accountId
 * と有効期限だけで、E2E の鍵材料（DEK・PRF 出力・封筒）は絶対に入れない
 * ——トークンは Authorization ヘッダで平文の wire に出るため。
 *
 * `requireSession` は api-3（issue #101）のプロビジョニング系ルートが再利用する。
 */

/** セッションの寿命。パスキー再認証は指紋ひとつなので長寿命にしない */
export const SESSION_TTL_SEC = 60 * 60 * 12;

/** 署名アルゴリズム。共有秘密（SESSION_SECRET）による対称鍵署名 */
const ALG = "HS256";

/** 発行したセッション。expiresAt はクライアントが再認証を先回りするための情報 */
export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: number;
}

/** accountId を subject にしたセッショントークンを発行する（now は epoch ミリ秒） */
export async function issueSession(
  accountId: string,
  secret: string,
  now: number,
): Promise<IssuedSession> {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SEC;
  const token = await sign({ sub: accountId, iat: issuedAt, exp: expiresAt }, secret, ALG);
  return { token, expiresAt };
}

/**
 * `Authorization: Bearer <token>` を検証し、accountId をコンテキストへ載せる。
 *
 * 失敗は理由を問わず 401 に潰す（期限切れ・署名不正・欠落の区別は攻撃者にだけ
 * 有用で、正規のクライアントは再ログインすればよい）。`alg` を明示することで
 * ヘッダの `alg` を信じた検証（alg=none 等）にならないようにする。
 */
export function requireSession(secret: string) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : null;
    if (token === null || token === "") {
      return c.json({ error: "認証が必要です" }, 401);
    }
    let payload: Awaited<ReturnType<typeof verify>>;
    try {
      payload = await verify(token, secret, ALG);
    } catch {
      return c.json({ error: "セッションが無効です" }, 401);
    }
    const sub = payload["sub"];
    if (typeof sub !== "string" || sub === "") {
      return c.json({ error: "セッションが無効です" }, 401);
    }
    c.set("accountId", sub);
    await next();
    return undefined;
  });
}
