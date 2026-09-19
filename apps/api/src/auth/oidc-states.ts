import { count, eq, lte } from "drizzle-orm";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { oidcStates } from "@zakki/api/db/schema.ts";

/**
 * OIDC の state / PKCE verifier / nonce の発行と消費（docs/MULTIUSER.md「ログイン（OIDC）」）。
 *
 * Workers はステートレスなので `/auth/oidc/:provider/start` → `/callback` の間の
 * state・PKCE verifier・nonce をメモリに置けない。コントロールプレーン DB の
 * 短命テーブルに載せ、callback では必ず「消してから判定する」（consume）ことで
 * 単回使用を保証する（旧 auth/challenges.ts と同じ設計）。
 */

/** state の寿命。認可コード フローの同意画面での滞在時間に余裕を持たせた幅 */
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * 同時に生きていられる state の上限（旧 auth/challenges.ts の MAX_LIVE_CHALLENGES と
 * 同じ理由・同じ値）。
 *
 * `/auth/oidc/:provider/start` は**未認証で叩けて 1 回ごとに DB へ 1 行書く**。
 * 期限切れ掃除があるので定常的には「レート × TTL」で頭打ちになるが、上限そのものは
 * 無かった。
 *
 * 本来は Worker の前段（Cloudflare の Rate Limiting Rules）で止めるのが筋だが、
 * **zone を持たない workers.dev 配備では zone ルールセットが適用されない**ため、
 * まずアプリ層で全体の上限を置く。IP 単位ではないので「誰かが埋めると他人も
 * ログインできない」性質はあるが、DB が無制限に書かれる方を先に断つ。
 * 独自ドメイン（zone）を持つ構成にしたら前段の rate limiting へ寄せる。
 *
 * 値は個人利用の実態から: 1 人が同時に持つ state は多くて数個で、TTL 10 分の間に
 * 200 個溜まるのは正常な使い方ではない。
 */
export const MAX_LIVE_OIDC_STATES = 200;

/** consume の結果。失敗理由を分けるのは呼び出し側が fragment のエラー種別を選ぶため */
export type ConsumeOidcStateResult =
  | { readonly ok: true; readonly codeVerifier: string; readonly nonce: string }
  | { readonly ok: false; readonly reason: "unknown" | "expired" | "provider-mismatch" };

/**
 * state を発行済みとして記録する。ついでに期限切れ行を掃除する
 * （Workers に定期実行が無いので、書き込みのたびに掃除するのが一番安い）。
 *
 * 生きている state が {@link MAX_LIVE_OIDC_STATES} に達していたら**書かずに
 * false を返す**。呼び出し側は 429 を返す。掃除の後に数えるので、
 * 上限に効くのは実際に生きている行だけ。
 */
export async function issueOidcState(
  db: ControlDb,
  params: {
    state: string;
    provider: string;
    codeVerifier: string;
    nonce: string;
    now: number;
  },
): Promise<boolean> {
  await db.delete(oidcStates).where(lte(oidcStates.expiresAt, params.now));
  const [live] = await db.select({ count: count() }).from(oidcStates);
  if (live !== undefined && live.count >= MAX_LIVE_OIDC_STATES) {
    return false;
  }
  await db.insert(oidcStates).values({
    state: params.state,
    provider: params.provider,
    codeVerifier: params.codeVerifier,
    nonce: params.nonce,
    expiresAt: params.now + OIDC_STATE_TTL_MS,
  });
  return true;
}

/**
 * state を消費する（単回使用）。
 *
 * DELETE ... RETURNING で「消えた行」を見る。先に読んでから消すと、同じ
 * state での同時 callback が両方成功し得る（リプレイ）ため、削除の成否を
 * そのまま所有権の判定に使う。期限切れ・provider 不一致は削除だけして無効を返す
 * （別プロバイダ用に発行した state を別パスの callback へ流し込めないようにする）。
 */
export async function consumeOidcState(
  db: ControlDb,
  params: { state: string; provider: string; now: number },
): Promise<ConsumeOidcStateResult> {
  const deleted = await db.delete(oidcStates).where(eq(oidcStates.state, params.state)).returning();
  const row = deleted[0];
  if (row === undefined) {
    return { ok: false, reason: "unknown" };
  }
  if (row.expiresAt <= params.now) {
    return { ok: false, reason: "expired" };
  }
  if (row.provider !== params.provider) {
    return { ok: false, reason: "provider-mismatch" };
  }
  return { ok: true, codeVerifier: row.codeVerifier, nonce: row.nonce };
}
