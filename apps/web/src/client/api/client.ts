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
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
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
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new ApiRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const api = {
  graph: () => request<GraphData>("/api/graph"),
  graphDelta: (since: string) =>
    request<GraphDelta>(`/api/graph?since=${encodeURIComponent(since)}`),
  dateChunk: (date?: string) =>
    request<Chunk>("/api/chunks/date", { method: "POST", ...json({ date }) }),
  chunkChildren: (id: number) => request<ChunkChildrenResponse>(`/api/chunks/${id}`),
  saveChildren: (id: number, converted: string) =>
    request<SaveChildrenResponse>(`/api/chunks/${id}/children`, {
      method: "PUT",
      ...json({ converted }),
    }),
  renameChunk: (id: number, content: string) =>
    request<{ ok: true }>(`/api/chunks/${id}`, { method: "PATCH", ...json({ content }) }),
  deleteChunk: (id: number) => request<{ ok: true }>(`/api/chunks/${id}`, { method: "DELETE" }),
  setUserTags: (id: number, names: string[]) =>
    request<{ ok: true }>(`/api/chunks/${id}/tags`, { method: "PUT", ...json({ names }) }),
  related: (id: number) => request<RelatedResponse>(`/api/chunks/${id}/related`),
  addLink: (from: number, to: number) =>
    request<{ ok: true }>("/api/links", { method: "POST", ...json({ from, to }) }),
  convert: (kana: string, leftContext?: string) =>
    request<ConvertResponse>("/api/convert", { method: "POST", ...json({ kana, leftContext }) }),
  conversionState: () => request<ConversionStateResponse>("/api/conversion/state"),
  saveConversion: (kana: string, converted: string) =>
    request<{ ok: true }>("/api/conversion/cache", {
      method: "POST",
      ...json({ kana, converted }),
    }),
  saveCorrection: (kana: string, chosen: string) =>
    request<{ ok: true }>("/api/conversion/corrections", {
      method: "POST",
      ...json({ kana, chosen }),
    }),
};
