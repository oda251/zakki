import type {
  ConvertRequest,
  DateChunkRequest,
  RenameChunkRequest,
  SaveChildrenRequest,
  SaveConversionRequest,
  SaveCorrectionRequest,
  SetUserTagsRequest,
} from "@zakki/web/shared/api-schemas.ts";
import type {
  Chunk,
  ChunkChildrenResponse,
  ConversionStateResponse,
  ConvertResponse,
  GraphData,
  GraphDelta,
  RelatedResponse,
  SaveChildrenResponse,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
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

export const api = {
  graph: () => request<GraphData>("/api/graph"),
  graphDelta: (since: string) =>
    request<GraphDelta>(`/api/graph?since=${encodeURIComponent(since)}`),
  dateChunk: (date?: DateChunkRequest["date"]) =>
    request<Chunk>("/api/chunks/date", {
      method: "POST",
      ...json({ date } satisfies DateChunkRequest),
    }),
  chunkChildren: (id: number) => request<ChunkChildrenResponse>(`/api/chunks/${id}`),
  saveChildren: (id: number, converted: SaveChildrenRequest["converted"]) =>
    request<SaveChildrenResponse>(`/api/chunks/${id}/children`, {
      method: "PUT",
      ...json({ converted } satisfies SaveChildrenRequest),
    }),
  renameChunk: (id: number, content: RenameChunkRequest["content"]) =>
    request<{ ok: true }>(`/api/chunks/${id}`, {
      method: "PATCH",
      ...json({ content } satisfies RenameChunkRequest),
    }),
  deleteChunk: (id: number) => request<{ ok: true }>(`/api/chunks/${id}`, { method: "DELETE" }),
  setUserTags: (id: number, names: SetUserTagsRequest["names"]) =>
    request<{ ok: true }>(`/api/chunks/${id}/tags`, {
      method: "PUT",
      ...json({ names } satisfies SetUserTagsRequest),
    }),
  related: (id: number) => request<RelatedResponse>(`/api/chunks/${id}/related`),
  addLink: (from: number, to: number) =>
    request<{ ok: true }>("/api/links", { method: "POST", ...json({ from, to }) }),
  convert: (kana: ConvertRequest["kana"], leftContext?: ConvertRequest["leftContext"]) =>
    request<ConvertResponse>("/api/convert", {
      method: "POST",
      ...json({ kana, leftContext } satisfies ConvertRequest),
    }),
  conversionState: () => request<ConversionStateResponse>("/api/conversion/state"),
  saveConversion: (
    kana: SaveConversionRequest["kana"],
    converted: SaveConversionRequest["converted"],
  ) =>
    request<{ ok: true }>("/api/conversion/cache", {
      method: "POST",
      ...json({ kana, converted } satisfies SaveConversionRequest),
    }),
  saveCorrection: (kana: SaveCorrectionRequest["kana"], chosen: SaveCorrectionRequest["chosen"]) =>
    request<{ ok: true }>("/api/conversion/corrections", {
      method: "POST",
      ...json({ kana, chosen } satisfies SaveCorrectionRequest),
    }),
};
