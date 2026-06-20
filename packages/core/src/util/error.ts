/** 捕捉した unknown をメッセージ文字列へ正規化する（各エラー型ファクトリで共有） */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
