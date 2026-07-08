import { API_BASE } from "@zakki/web/shared/api-base.ts";

/** API エラー（fetch 失敗・非 2xx）。UI はメッセージ表示のみ */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiRequestError";
  }
}

/**
 * fetch 互換の最小型（テスト・Hono `app.request` を注入できるよう構造的に絞る。
 * bun の `typeof fetch` は preconnect 等の静的プロパティまで要求するため使わない）
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * path は API_BASE からの相対（例: "/convert"）。プレフィクスはここで一元的に付与する。
 * fetchFn は replication / unlock（issue #43）がテスト用 Hono app を注入するための穴
 */
export async function request<T>(
  path: string,
  init?: RequestInit,
  fetchFn: FetchLike = fetch,
): Promise<T> {
  const res = await fetchFn(`${API_BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : res.statusText;
    throw new ApiRequestError(res.status, message);
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- HTTP JSON は untyped。サーバの api-types と 1:1 の呼び出し規約を型に読み替える境界
  return (await res.json()) as T;
}
