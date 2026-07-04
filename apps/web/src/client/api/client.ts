import type {
  ConversionStateResponse,
  ConvertResponse,
  GraphData,
  RelatedResponse,
  Session,
  SessionEntryResponse,
  SessionWithTags,
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
  sessions: () => request<SessionWithTags[]>("/api/sessions"),
  defaultSession: (date?: string) =>
    request<Session>("/api/sessions/default", { method: "POST", ...json({ date }) }),
  createSession: (name: string, date?: string) =>
    request<Session>("/api/sessions", { method: "POST", ...json({ name, date }) }),
  renameSession: (id: number, name: string) =>
    request<{ ok: true }>(`/api/sessions/${id}`, { method: "PATCH", ...json({ name }) }),
  deleteSession: (id: number) => request<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  setSessionTags: (id: number, names: string[]) =>
    request<{ ok: true }>(`/api/sessions/${id}/tags`, { method: "PUT", ...json({ names }) }),
  sessionEntry: (id: number) => request<SessionEntryResponse>(`/api/sessions/${id}/entry`),
  saveEntry: (id: number, raw: string, converted: string) =>
    request<SessionEntryResponse>(`/api/sessions/${id}/entry`, {
      method: "PUT",
      ...json({ raw, converted }),
    }),
  related: (id: number) => request<RelatedResponse>(`/api/sessions/${id}/related`),
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
