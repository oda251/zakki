import { API_BASE } from "@zakki/web/shared/api-base.ts";
import type { ConvertRequest, SaveConversionRequest } from "@zakki/web/shared/api-schemas.ts";
import type {
  ConversionStateResponse,
  ConvertResponse,
  RelatedResponse,
} from "@zakki/web/shared/api-types.ts";

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

/** 送信リテラルは `satisfies <XxxRequest>` で注釈し、スキーマ派生型との乖離をコンパイルエラー化する */
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/**
 * chunk の読み書きは RxDB（liveQuery + replication）へ移行済みで、ここに残るのは
 * replication で代替できないサーバ機能のみ（#44）:
 * - convert / conversion*: 変換エンジン（anco）とそのキャッシュ。#26 でクライアント移設予定
 * - related: 埋め込み（サーバ解析の産物）による意味的近傍
 */
export const api = {
  related: (id: number) => request<RelatedResponse>(`/chunks/${id}/related`),
  convert: (kana: ConvertRequest["kana"], leftContext?: ConvertRequest["leftContext"]) =>
    request<ConvertResponse>("/convert", {
      method: "POST",
      ...json({ kana, leftContext } satisfies ConvertRequest),
    }),
  conversionState: () => request<ConversionStateResponse>("/conversion/state"),
  saveConversion: (
    kana: SaveConversionRequest["kana"],
    converted: SaveConversionRequest["converted"],
  ) =>
    request<{ ok: true }>("/conversion/cache", {
      method: "POST",
      ...json({ kana, converted } satisfies SaveConversionRequest),
    }),
};
