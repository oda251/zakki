import type { ControlDb } from "@zakki/api/db/client.ts";

/**
 * Hono のコンテキスト変数の型（issue #99 / #100）。
 *
 * 認証の有無を型で分けている: 素の {@link ApiEnv} は `db` しか持たず、
 * `accountId` は `requireSession` を通した先の {@link SessionEnv} にだけ現れる。
 * 1 つの Env に `accountId?: string` を混ぜると、未保護のルートでも
 * `c.get("accountId")` が書けてしまい「認証済みのつもり」を型が許してしまうため。
 */

/** 全ルート共通。合成点が注入した DB をコンテキスト変数で配る */
export interface ApiEnv {
  Variables: { db: ControlDb };
}

/**
 * `requireSession` を通したルート専用。accountId は検証済みセッションの subject、
 * sessionEpoch はトークンに焼かれたセッション世代（issue #117）で、
 * `requireActiveSession` が台帳の現在値と突き合わせるために使う。
 */
export interface SessionEnv {
  Variables: { db: ControlDb; accountId: string; sessionEpoch: number };
}
