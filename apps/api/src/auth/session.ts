import { eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";
import type { SessionEnv } from "@zakki/api/context.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { accounts } from "@zakki/api/db/schema.ts";

/**
 * セッション（issue #100）。
 *
 * Workers はステートレスなのでサーバ側セッションストアを持たず、署名付きの
 * 自己完結トークン（JWT / HS256, SESSION_SECRET）にする。載せるのは accountId
 * と有効期限だけで、E2E の鍵材料（DEK・PRF 出力・封筒）は絶対に入れない
 * ——トークンは Authorization ヘッダで平文の wire に出るため。
 *
 * `requireSession` は api-3（issue #101）のプロビジョニング系ルートが再利用する。
 *
 * ステートレスなので「発行済みトークンを止める」手段が本来無い。それを補うのが
 * セッション世代（epoch, issue #117）で、accounts の 1 整数と JWT の claim の
 * 突き合わせだけで一斉失効を表現する（{@link requireActiveSession}）。
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

/**
 * accountId を subject にしたセッショントークンを発行する（now は epoch ミリ秒）。
 *
 * `sessionEpoch` は発行時点の accounts.session_epoch。これを焼き込むことで
 * 「いつの世代のログインか」がトークン自身に載り、ログアウト（世代 +1）以降の
 * 検証で古いトークンを見分けられる（issue #117）。世代番号はアカウント内で
 * 単調増加するだけの整数で、鍵材料でも個人情報でもない。
 */
export async function issueSession(
  accountId: string,
  secret: string,
  now: number,
  sessionEpoch: number,
): Promise<IssuedSession> {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SEC;
  const token = await sign(
    { sub: accountId, epoch: sessionEpoch, iat: issuedAt, exp: expiresAt },
    secret,
    ALG,
  );
  return { token, expiresAt };
}

/**
 * `Authorization: Bearer <token>` を検証し、accountId とセッション世代を
 * コンテキストへ載せる。
 *
 * 失敗は理由を問わず 401 に潰す（期限切れ・署名不正・欠落の区別は攻撃者にだけ
 * 有用で、正規のクライアントは再ログインすればよい）。`alg` を明示することで
 * ヘッダの `alg` を信じた検証（alg=none 等）にならないようにする。
 *
 * ここが見るのはトークン単体で完結する事実（署名・期限・形）だけ。台帳と
 * 突き合わせる失効判定は {@link requireActiveSession} が担う。
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
    const epoch = payload["epoch"];
    // 世代の無いトークン（#117 以前に発行されたもの・手組みの偽造）は通さない。
    // 「claim が無ければ 0 とみなす」にすると、claim を落とすだけで失効を回避できる
    if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
      return c.json({ error: "セッションが無効です" }, 401);
    }
    c.set("accountId", sub);
    c.set("sessionEpoch", epoch);
    await next();
    return undefined;
  });
}

/**
 * セッションが今も生きているかを台帳で確かめる（退会 #116 / 失効 #117）。
 * **{@link requireSession} の直後**に置く（accountId と世代が載っていることが前提）。
 *
 * 見るのは 2 つで、どちらも同じ 1 行から読めるので**クエリは 1 回**:
 *
 * 1. **アカウントが実在するか**（退会, #116）。セッションは自己完結トークンなので、
 *    退会しても発行済みのトークンは最長 {@link SESSION_TTL_SEC} の間、署名としては
 *    有効なままになる。それを持って `GET /me/db` を叩けば `ensureUserDatabase` が
 *    「台帳に無い＝初回」と判断して**消したはずの DB を作り直す**——退会が退会にならない。
 * 2. **世代が現在のものか**（失効, #117）。`POST /auth/logout` は accounts の
 *    session_epoch を +1 するだけで、そのアカウントが過去に発行したトークンを
 *    まとめて「古い世代」にする。端末を盗まれた・トークンが漏れたときの止め方がこれ。
 *
 * 不一致はどちらも 401 に潰す（requireSession と同じ理由。「退会済み」「ログアウト済み」
 * 「そもそも知らない ID」を呼び出し側に区別させない）。
 */
export function requireActiveSession(db: ControlDb) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    const rows = await db
      .select({ sessionEpoch: accounts.sessionEpoch })
      .from(accounts)
      .where(eq(accounts.id, c.get("accountId")))
      .limit(1);
    const current = rows[0];
    if (current === undefined || current.sessionEpoch !== c.get("sessionEpoch")) {
      return c.json({ error: "セッションが無効です" }, 401);
    }
    await next();
    return undefined;
  });
}

/**
 * そのアカウントの発行済みセッションを一斉に失効させる（`POST /auth/logout`, #117）。
 *
 * 読んでから書く（現在値を select → +1 して update）と、2 台から同時にログアウト
 * したときに双方が同じ値を読んで同じ値を書き、世代が 1 つしか進まない——先に
 * 発行されたトークンが生き残る余地ができる。SQLite は 1 文を原子的に実行するので、
 * 加算そのものを SQL 側に置いて読み書きを分けない（#115 の DELETE と同じ方針）。
 */
export async function revokeSessions(db: ControlDb, accountId: string): Promise<void> {
  await db
    .update(accounts)
    .set({ sessionEpoch: sql`${accounts.sessionEpoch} + 1` })
    .where(eq(accounts.id, accountId));
}
