import type { WireDoc } from "@zakki/web/server/replication/store.ts";

/**
 * replication テスト共有の wire doc ファクトリ（テスト専用。プロダクションからは
 * import しない）。content は暗号文 base64 の想定で、サーバは中身を解釈しない。
 */
export const wire = (
  id: string,
  updatedAt: string,
  over: Record<string, unknown> = {},
): WireDoc => ({
  id,
  updatedAt,
  _deleted: false,
  content: `enc:${id}`,
  ...over,
});
