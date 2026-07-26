import { eq, lte } from "drizzle-orm";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { authChallenges } from "@zakki/api/db/schema.ts";

/**
 * WebAuthn challenge の発行と消費（issue #100）。
 *
 * Workers はステートレスなので options → verify の間の challenge をメモリに
 * 置けない。コントロールプレーン DB の短命テーブルに載せ、verify では必ず
 * 「消してから判定する」（consume）ことで単回使用を保証する。
 */

/** challenge の寿命。WebAuthn の既定タイムアウト（60s）にユーザ操作の余裕を足した幅 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * challenge の用途。登録用の challenge を認証に流用させない。
 *
 * "credential"（issue #115）は「ログイン済みアカウントへのパスキー追加」で、
 * "registration"（新規アカウント作成）と分けてあるのが要点: 同じ kind にすると
 * 追加用の challenge を `/auth/register/verify` へ流し込めてしまい、既存 accountId で
 * accounts を作り直す経路が生える。
 */
export type ChallengeKind = "registration" | "authentication" | "credential";

/** consume の結果。失敗理由を分けるのは呼び出し側がメッセージを変えるため */
export type ConsumeResult =
  | {
      readonly ok: true;
      readonly accountId: string | null;
      /** options 発行時に決めた表示名（issue #118）。未設定なら null */
      readonly displayName: string | null;
    }
  | { readonly ok: false; readonly reason: "unknown" | "expired" };

/**
 * challenge を発行済みとして記録する。ついでに期限切れ行を掃除する
 * （Workers に定期実行が無いので、書き込みのたびに掃除するのが一番安い）。
 */
export async function issueChallenge(
  db: ControlDb,
  params: {
    challenge: string;
    kind: ChallengeKind;
    accountId?: string;
    /** 認証器に渡した userDisplayName。verify で credentials へ写す（issue #118） */
    displayName?: string;
    now: number;
  },
): Promise<void> {
  await db.delete(authChallenges).where(lte(authChallenges.expiresAt, params.now));
  await db.insert(authChallenges).values({
    challenge: params.challenge,
    kind: params.kind,
    accountId: params.accountId ?? null,
    displayName: params.displayName ?? null,
    expiresAt: params.now + CHALLENGE_TTL_MS,
  });
}

/**
 * challenge を消費する（単回使用）。
 *
 * DELETE ... RETURNING で「消えた行」を見る。先に読んでから消すと、同じ
 * challenge の同時 verify が両方成功し得る（リプレイ）ため、削除の成否を
 * そのまま所有権の判定に使う。期限切れは削除だけして無効を返す。
 */
export async function consumeChallenge(
  db: ControlDb,
  params: { challenge: string; kind: ChallengeKind; now: number },
): Promise<ConsumeResult> {
  const deleted = await db
    .delete(authChallenges)
    .where(eq(authChallenges.challenge, params.challenge))
    .returning();
  const row = deleted[0];
  // 用途違いは「そんな challenge は知らない」と同じ扱いにする（探索の手掛かりを与えない）
  if (row === undefined || row.kind !== params.kind) {
    return { ok: false, reason: "unknown" };
  }
  if (row.expiresAt <= params.now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, accountId: row.accountId, displayName: row.displayName };
}
