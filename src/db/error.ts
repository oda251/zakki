import { Result } from "neverthrow";
import { errorMessage } from "@/util/error.ts";

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

/** 同期 DB 操作を Result に包む共通ヘルパー */
export function tryDb<T>(fn: () => T): Result<T, DbError> {
  return Result.fromThrowable(fn, toDbError)();
}
