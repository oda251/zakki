import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useGraphStore } from "./graph.ts";
import { useSessionStore } from "./session.ts";

const SESSION = {
  id: 42,
  name: "調査",
  date: "2026-07-05",
  createdAt: "",
  updatedAt: "",
  tags: [] as string[],
};

const originalFetch = globalThis.fetch;

/** api クライアントの fetch をパスで振り分けるスタブ */
function stubFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url.includes("/api/sessions/default")) return json(SESSION);
    if (url.includes("/entry")) return json({ entry: null, chunks: [] });
    if (url.includes("/related")) return json({ items: [] });
    if (url.includes("/api/sessions")) return json([SESSION]);
    return json({});
  }) as typeof fetch;
}

beforeEach(() => {
  stubFetch();
  useSessionStore.setState({ current: null, initialRaw: null, related: [], error: null });
  useGraphStore.setState({
    filter: { sessionIds: new Set<number>(), tag: null, sessionTag: null },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("セッションを開くとグラフがそのセッション単位の表示になる", () => {
  test("openSession 成功時に graph filter がそのセッションだけになる", async () => {
    await useSessionStore.getState().openSession(42);
    expect(useSessionStore.getState().current?.id).toBe(42);
    expect([...useGraphStore.getState().filter.sessionIds]).toEqual([42]);
  });

  test("openToday 成功時も同様にリセットされる", async () => {
    useGraphStore.getState().toggleSession(999); // 事前フィルタは上書きされる
    await useSessionStore.getState().openToday();
    expect([...useGraphStore.getState().filter.sessionIds]).toEqual([42]);
  });
});
