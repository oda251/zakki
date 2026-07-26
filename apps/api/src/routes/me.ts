import { Hono } from "hono";
import type { SessionEnv } from "@zakki/api/context.ts";
import { requireActiveSession, requireSession } from "@zakki/api/auth/session.ts";
import type { AppDeps } from "@zakki/api/deps.ts";
import { databaseUrl, deleteAccount, ensureUserDatabase } from "@zakki/api/turso/provision.ts";

/**
 * ログイン済みアカウント向けのエンドポイント（issue #101 / #116）。
 *
 * `GET /me/db` は「自分のジャーナル DB をどこで、どう開くか」を返す。DB が無ければ
 * その場で Turso に作る（per-user DB は IaC 管理外・実行時生成, RESEARCH.md §7）。
 *
 * 返すのは DB の URL と**都度発行の短命トークン**だけで、E2E の鍵材料は含まない。
 * wrapped DEK はユーザ自身の DB の中にあり、サーバは復号できない立場を保つ。
 *
 * `DELETE /me` は退会（issue #116）。対象は常に**セッションの持ち主自身**で、
 * 消す相手を指定する経路（パスパラメータ・本文）は用意しない——他人を消せる
 * 引数が無ければ、権限判定を間違える余地も無い。
 */

/**
 * DB トークンの寿命。Workers はセッションを跨いで状態を持たないので、この API は
 * 毎回叩かれる前提で短く切る（漏洩時の窓を小さくする / 台帳に保存しないので
 * 失効管理も要らない）。
 */
const TOKEN_TTL_MIN = 60;

/** Turso の期間表記。TTL の単一の出どころから作る */
const TOKEN_EXPIRATION = `${TOKEN_TTL_MIN}m`;

export function meRoutes(deps: AppDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  const { db, auth, turso } = deps;

  // 認証必須。#100 の requireSession をそのまま再利用し、退会済みアカウント（#116）と
  // ログアウト済み世代（#117）の生き残りトークンを requireActiveSession で弾く
  // （前者が無いと退会後の `GET /me/db` が消したはずの DB を作り直す）。
  // 適用範囲は登録順ではなくパスで示す（`"*"` だと後からルートを足したときに
  // 保護漏れが読み取れない。#110 レビューで auth.ts に入れたのと同じ形）
  app.use("/db", requireSession(auth.sessionSecret), requireActiveSession(db));
  // `DELETE /me` 自身も同じ保護下に置く。二重の退会は 401 になるが、DB 削除に
  // 失敗した中途半端な状態では accounts 行が残っている（= 再試行は通る）
  app.use("/", requireSession(auth.sessionSecret), requireActiveSession(db));

  app.get("/db", async (c) => {
    const accountId = c.get("accountId");
    const now = Date.now();

    const ensured = await ensureUserDatabase(db, turso, accountId, now);
    if (ensured.isErr()) {
      // Platform API の内部メッセージは wire に出さずログへ（auth.ts と同じ方針）。
      // 502: 上流（Turso）が応えないだけで、こちらのリクエストは正しい
      console.error("[me/db] provisioning failed:", ensured.error);
      return c.json({ error: "データベースを準備できませんでした" }, 502);
    }

    const token = await turso.issueToken(ensured.value.name, {
      expiration: TOKEN_EXPIRATION,
      authorization: "full-access",
    });
    if (token.isErr()) {
      console.error("[me/db] token issue failed:", token.error);
      return c.json({ error: "データベーストークンを発行できませんでした" }, 502);
    }

    // 本文にベアラトークンを載せるので、どの階層にも残さない
    c.header("Cache-Control", "no-store");
    return c.json({
      dbUrl: databaseUrl(ensured.value.hostname),
      token: token.value,
      // クライアントが失効を先回りして取り直すための情報（セッションと同じ epoch 秒）
      expiresAt: Math.floor(now / 1000) + TOKEN_TTL_MIN * 60,
    });
  });

  app.delete("/", async (c) => {
    const removed = await deleteAccount(db, turso, c.get("accountId"));
    if (removed.isErr()) {
      // 台帳・accounts 行は消していないので、同じリクエストの再送で続きから完了できる。
      // Platform API の内部メッセージは wire に出さずログへ（`GET /db` と同じ方針）
      console.error("[me] account deletion failed:", removed.error);
      return c.json({ error: "アカウントを削除できませんでした" }, 502);
    }
    // 返すものが無い。以降このセッションは requireActiveSession で 401 になる
    return c.body(null, 204);
  });

  return app;
}
