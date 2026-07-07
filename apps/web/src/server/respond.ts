import type { Context } from "hono";
import type { ResultAsync } from "neverthrow";

/**
 * ResultAsync を JSON レスポンスへ写す共通ヘルパー。
 * Ok は 200（map で DTO 化済みの値）、Err は 500 { error } に統一する。
 *
 * Err の message は SQL・子プロセスの生メッセージ等の内部事情を含み得るため
 * wire に出さない（issue #58 項目 4）: 全容はサーバログへ、レスポンスは定型文のみ。
 * 4xx（入力検証）は respond に入る前に各 route（parseBody）が返す。
 */
export function respond<T extends object, E extends { message: string }>(
  c: Context,
  result: ResultAsync<T, E>,
): Promise<Response> {
  return result.match(
    (value) => c.json(value),
    (e) => {
      console.error(`[respond] ${c.req.method} ${c.req.path} failed:`, e);
      return c.json({ error: "サーバ内部エラー" }, 500);
    },
  );
}
