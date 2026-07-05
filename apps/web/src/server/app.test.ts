import { beforeEach, describe, expect, test } from "bun:test";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import type { Hono } from "hono";
import type {
  ConversionStateResponse,
  ConvertResponse,
  GraphData,
  HealthResponse,
  Session,
  SessionEntryResponse,
  SessionWithTags,
} from "@zakki/web/shared/api-types.ts";
import { createAnalysisScheduler } from "./analysis.ts";
import { createApp } from "./app.ts";

let db: Db;
let app: Hono;
let analysis: ReturnType<typeof createAnalysisScheduler>;

beforeEach(async () => {
  db = await createDb(":memory:");
  // テストはデバウンス 0ms（settle() で完了を待てる）
  analysis = createAnalysisScheduler(db, null, () => {}, 0);
  app = createApp({ db, engine: identityEngine, embedder: null, analysis });
});

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

function put(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/health", () => {
  test("エンジン名と embedder の有無を返す", async () => {
    const health = await json<HealthResponse>(await app.request("/api/health"));
    expect(health).toEqual({ engine: "identity", embedder: false });
  });
});

describe("sessions CRUD", () => {
  test("default → 一覧 → 名前付き作成 → rename → タグ → 削除", async () => {
    const def = await json<Session>(await app.request(post("/api/sessions/default", {})));
    expect(def.name).toBeNull();

    const named = await json<Session>(
      await app.request(post("/api/sessions", { name: "調査", date: "2026-07-05" })),
    );
    expect(named.name).toBe("調査");

    const renamed = await app.request(
      new Request(`http://x/api/sessions/${named.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "設計" }),
      }),
    );
    expect(renamed.status).toBe(200);

    await json(await app.request(put(`/api/sessions/${named.id}/tags`, { names: ["web", "ui"] })));

    const list = await json<SessionWithTags[]>(await app.request("/api/sessions"));
    expect(list).toHaveLength(2);
    const found = list.find((s) => s.id === named.id);
    expect(found?.name).toBe("設計");
    expect(found?.tags).toEqual(["web", "ui"]);

    const deleted = await app.request(`/api/sessions/${named.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const after = await json<SessionWithTags[]>(await app.request("/api/sessions"));
    expect(after.map((s) => s.id)).toEqual([def.id]);
  });

  test("空名の作成・不正 body は 400", async () => {
    expect((await app.request(post("/api/sessions", { name: "" }))).status).toBe(400);
    expect((await app.request(post("/api/sessions", "x"))).status).toBe(400);
  });
});

describe("entry の保存と読み出し", () => {
  test("PUT で保存（チャンク化込み）→ GET で往復。解析も予約される", async () => {
    const def = await json<Session>(
      await app.request(post("/api/sessions/default", { date: "2026-07-05" })),
    );

    const saved = await json<SessionEntryResponse>(
      await app.request(
        put(`/api/sessions/${def.id}/entry`, {
          raw: "kyouhahare.\nsanposhita.",
          converted: "きょうははれ。\nさんぽした。",
        }),
      ),
    );
    expect(saved.chunks.map((c) => c.content)).toEqual(["きょうははれ。", "さんぽした。"]);

    const loaded = await json<SessionEntryResponse>(
      await app.request(`/api/sessions/${def.id}/entry`),
    );
    expect(loaded.entry?.raw).toBe("kyouhahare.\nsanposhita.");
    expect(loaded.chunks).toHaveLength(2);

    // 解析（タグ付け）がデバウンス後に走る
    await analysis.settle();
    const graph = await json<GraphData>(await app.request("/api/graph"));
    expect(graph.nodes).toHaveLength(2);
  });

  test("存在しないセッションへの保存は 404、entry 未作成は null", async () => {
    const missing = await app.request(put("/api/sessions/9999/entry", { raw: "", converted: "" }));
    expect(missing.status).toBe(404);

    const def = await json<Session>(await app.request(post("/api/sessions/default", {})));
    const empty = await json<SessionEntryResponse>(
      await app.request(`/api/sessions/${def.id}/entry`),
    );
    expect(empty.entry).toBeNull();
    expect(empty.chunks).toEqual([]);
  });
});

describe("変換 API", () => {
  test("convert は候補列を返す（identity はかなを素通し）", async () => {
    const res = await json<ConvertResponse>(
      await app.request(post("/api/convert", { kana: "きょうははれ" })),
    );
    expect(res.candidates).toEqual(["きょうははれ"]);
  });

  test("conversion/state は corrections と cache を返す", async () => {
    await json(
      await app.request(post("/api/conversion/corrections", { kana: "き", chosen: "木" })),
    );
    await json(
      await app.request(post("/api/conversion/cache", { kana: "はれ", converted: "晴れ" })),
    );
    const state = await json<ConversionStateResponse>(await app.request("/api/conversion/state"));
    expect(state.corrections).toEqual({ き: "木" });
    expect(state.cache).toEqual({ はれ: "晴れ" });
  });
});

describe("POST /api/links（手動リンク）", () => {
  test("作成した manual リンクが graph に反映される", async () => {
    const def = await json<Session>(await app.request(post("/api/sessions/default", {})));
    const saved = await json<SessionEntryResponse>(
      await app.request(put(`/api/sessions/${def.id}/entry`, { raw: "", converted: "一。\n二。" })),
    );
    const [a, b] = saved.chunks.map((c) => c.id);
    if (a === undefined || b === undefined) throw new Error("seed 不足");

    await json(await app.request(post("/api/links", { from: b, to: a })));

    const graph = await json<GraphData>(await app.request("/api/graph"));
    expect(graph.edges).toEqual([{ from: a, to: b, score: 1, origin: "manual" }]);
  });

  test("不正 body は 400", async () => {
    expect((await app.request(post("/api/links", { from: 1 }))).status).toBe(400);
    expect((await app.request(post("/api/links", { from: "x", to: 2 }))).status).toBe(400);
  });
});

describe("グラフとセッション関連", () => {
  test("graph はノード・エッジ・セッションを返す（空 DB は空）", async () => {
    const graph = await json<GraphData>(await app.request("/api/graph"));
    expect(graph).toEqual({ nodes: [], edges: [], sessions: [] });
  });

  test("related は embedder なしでは空", async () => {
    const def = await json<Session>(await app.request(post("/api/sessions/default", {})));
    const related = await json<{ items: unknown[] }>(
      await app.request(`/api/sessions/${def.id}/related`),
    );
    expect(related.items).toEqual([]);
  });
});
