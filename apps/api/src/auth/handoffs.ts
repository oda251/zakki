import { eq } from "drizzle-orm";
import type { ControlDb } from "@zakki/api/db/client.ts";
import { loginHandoffs } from "@zakki/api/db/schema.ts";

/**
 * ログイン handoff の使い捨てコード（docs/tmp/oidc-google-login.md）。
 *
 * OIDC の callback はブラウザへの 302 リダイレクトで終わるため、この時点で
 * セッション JWT をそのまま URL に載せると履歴・Referer・アクセスログに残る
 * （fragment はサーバへ送られないが履歴には残る）。そこで callback は本物のセッションの
 * 代わりに、この一度きりの短命コードだけを `APP_ORIGIN/#login=<code>` に載せる。
 * SPA は fragment を読んだ直後に消し、`POST /auth/login/exchange` で本物のセッションに
 * 換える（{@link consumeLoginHandoff}）。
 */

/** コードの寿命。SPA が fragment を読んで即座に交換するだけなので短くてよい */
export const LOGIN_HANDOFF_TTL_MS = 60 * 1000;

/** コードのバイト長。32 バイト = 256bit あれば推測されない */
const CODE_BYTES = 32;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** handoff コードを発行する（callback が呼ぶ。単回使用は consume 側の DELETE で保証） */
export async function issueLoginHandoff(
  db: ControlDb,
  params: { accountId: string; now: number },
): Promise<string> {
  const code = base64Url(crypto.getRandomValues(new Uint8Array(CODE_BYTES)));
  await db.insert(loginHandoffs).values({
    code,
    accountId: params.accountId,
    expiresAt: params.now + LOGIN_HANDOFF_TTL_MS,
  });
  return code;
}

/**
 * handoff コードを消費する（単回使用）。
 *
 * DELETE ... RETURNING で「消えた行」を見る。先に読んでから消すと、同じ
 * code の同時 exchange が両方成功し得る（リプレイ）ため、削除の成否をそのまま
 * 所有権の判定に使う。期限切れは削除だけして無効を返す。
 */
export async function consumeLoginHandoff(
  db: ControlDb,
  params: { code: string; now: number },
): Promise<string | null> {
  const deleted = await db
    .delete(loginHandoffs)
    .where(eq(loginHandoffs.code, params.code))
    .returning();
  const row = deleted[0];
  if (row === undefined) return null;
  if (row.expiresAt <= params.now) return null;
  return row.accountId;
}
