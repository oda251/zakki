import type { Context } from "hono";
import type { ResultAsync } from "neverthrow";
import type { DbError } from "@zakki/data/db/error.ts";

/**
 * ResultAsync を JSON レスポンスへ写す共通ヘルパー。
 * Ok は 200（map で DTO 化済みの値）、Err は 500 { error } に統一する。
 */
export function respond<T extends object>(
  c: Context,
  result: ResultAsync<T, DbError>,
): Promise<Response> {
  return result.match(
    (value) => c.json(value),
    (e) => c.json({ error: e.message }, 500),
  );
}
