import { ResultAsync } from "neverthrow";
import { errorMessage } from "@zakki/core/util/error.ts";

export interface DbError {
  readonly type: "db-error";
  readonly message: string;
  readonly cause: unknown;
}

const toDbError = (cause: unknown): DbError => ({
  type: "db-error",
  message: errorMessage(cause),
  cause,
});

/** DB 操作を伴わない検証エラーを DbError に写す（neverthrow の同期 err で使う） */
export function dbError(message: string): DbError {
  return { type: "db-error", message, cause: undefined };
}

/** 非同期 DB 操作を ResultAsync に包む共通ヘルパー（libSQL は async） */
export function tryDbAsync<T>(fn: () => Promise<T>): ResultAsync<T, DbError> {
  return ResultAsync.fromPromise(fn(), toDbError);
}
