import { beforeEach, describe, expect, test } from "bun:test";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { chunks } from "@zakki/data/db/schema.ts";
import type { Hono } from "hono";
import type {
  Chunk,
  ChunkChildrenResponse,
  ConversionStateResponse,
  ConvertResponse,
  GraphData,
  GraphDelta,
  SaveChildrenResponse,
} from "@zakki/web/shared/api-types.ts";
import { createAnalysisScheduler } from "./analysis.ts";
import { createApp } from "./app.ts";
import { createAnalysisEvents } from "./events.ts";

let db: Db;
let app: Hono;
let analysis: ReturnType<typeof createAnalysisScheduler>;

beforeEach(async () => {
  db = await createDb(":memory:");
  // テストはデバウンス 0ms（settle() で完了を待てる）
  analysis = createAnalysisScheduler(db, null, () => {}, 0);
  app = createApp({
    db,
    engine: identityEngine,
    embedder: null,
    analysis,
    events: createAnalysisEvents(),
  });
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

function patch(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/health", () => {
  test("エンジン名と embedder の有無を返す", async () => {
    // health の形はこのテストだけが消費する（shared の HealthResponse は #49 で削除）
    const health = await json<{ engine: string; embedder: boolean }>(
      await app.request("/api/health"),
    );
    expect(health).toEqual({ engine: "identity", embedder: false });
  });
});

describe("chunks CRUD", () => {
  test("日付チャンク → バッファ保存（コンテナ行）→ rename → タグ → 削除", async () => {
    const date = await json<Chunk>(
      await app.request(post("/api/chunks/date", { date: "2026-07-05" })),
    );
    expect(date.parentId).toBeNull();
    expect(date.date).toBe("2026-07-05");
    // 冪等（1 日 1 件）
    const again = await json<Chunk>(
      await app.request(post("/api/chunks/date", { date: "2026-07-05" })),
    );
    expect(again.id).toBe(date.id);

    // コンテナの作成 = 親バッファへの行追記（専用エンドポイントは無い）
    const saved = await json<SaveChildrenResponse>(
      await app.request(put(`/api/chunks/${date.id}/children`, { converted: "調査\n" })),
    );
    const container = saved.children[0];
    if (container === undefined) throw new Error("seed 不足");
    expect(container.content).toBe("調査");

    const renamed = await app.request(patch(`/api/chunks/${container.id}`, { content: "設計" }));
    expect(renamed.status).toBe(200);

    await json(
      await app.request(put(`/api/chunks/${container.id}/tags`, { names: ["web", "ui"] })),
    );

    const graph = await json<GraphData>(await app.request("/api/graph"));
    const node = graph.nodes.find((x) => x.id === container.id);
    expect(node?.content).toBe("設計");
    expect(node?.userTags).toEqual(["web", "ui"]);

    const deleted = await app.request(`/api/chunks/${container.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const after = await json<GraphData>(await app.request("/api/graph"));
    expect(after.nodes.map((x) => x.id)).toEqual([date.id]);
  });

  test("日付チャンクの rename・不正 body は 400/500 系で弾く", async () => {
    const date = await json<Chunk>(await app.request(post("/api/chunks/date", {})));
    expect((await app.request(patch(`/api/chunks/${date.id}`, { content: "改名" }))).status).toBe(
      500,
    );
    expect((await app.request(patch(`/api/chunks/${date.id}`, {}))).status).toBe(400);
    expect((await app.request(post("/api/chunks/date", { date: "07-05" }))).status).toBe(400);
  });
});

describe("バッファの保存と読み出し", () => {
  test("PUT children で保存（チャンク化込み）→ GET で往復。解析も予約される", async () => {
    const date = await json<Chunk>(
      await app.request(post("/api/chunks/date", { date: "2026-07-05" })),
    );

    const saved = await json<SaveChildrenResponse>(
      await app.request(
        put(`/api/chunks/${date.id}/children`, {
          converted: "きょうははれ。\nさんぽした。",
        }),
      ),
    );
    expect(saved.children.map((c) => c.content)).toEqual(["きょうははれ。", "さんぽした。"]);

    const loaded = await json<ChunkChildrenResponse>(await app.request(`/api/chunks/${date.id}`));
    expect(loaded.chunk.id).toBe(date.id);
    expect(loaded.children).toHaveLength(2);

    // 解析（タグ付け）がデバウンス後に走る。日付チャンクはノードだが解析対象外
    await analysis.settle();
    const graph = await json<GraphData>(await app.request("/api/graph"));
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.find((n) => n.id === date.id)?.childCount).toBe(2);
  });

  test("存在しないチャンクへの保存・読み出しは 404", async () => {
    expect((await app.request(put("/api/chunks/9999/children", { converted: "" }))).status).toBe(
      404,
    );
    expect((await app.request("/api/chunks/9999")).status).toBe(404);
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
    const date = await json<Chunk>(await app.request(post("/api/chunks/date", {})));
    const saved = await json<SaveChildrenResponse>(
      await app.request(put(`/api/chunks/${date.id}/children`, { converted: "一。\n二。" })),
    );
    const [a, b] = saved.children.map((c) => c.id);
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

describe("グラフ", () => {
  test("graph はノード・エッジを返す（空 DB は空）", async () => {
    const graph = await json<GraphData>(await app.request("/api/graph"));
    expect(graph).toEqual({ version: "", nodes: [], edges: [] });
  });

  test("不正な since は 400", async () => {
    expect((await app.request("/api/graph?since=abc")).status).toBe(400);
  });

  test('?since= 空文字は 400 でなく全量応答（空 DB 起動直後の version="" を since に使う回帰）', async () => {
    const graph = await json<GraphData>(await app.request("/api/graph?since="));
    expect(graph).toEqual({ version: "", nodes: [], edges: [] });
  });

  test("日付チャンク間の chrono エッジが graph に載る", async () => {
    const d1 = await json<Chunk>(
      await app.request(post("/api/chunks/date", { date: "2026-07-01" })),
    );
    const d2 = await json<Chunk>(
      await app.request(post("/api/chunks/date", { date: "2026-07-02" })),
    );
    const graph = await json<GraphData>(await app.request("/api/graph"));
    expect(graph.edges).toEqual([{ from: d1.id, to: d2.id, score: 1, origin: "chrono" }]);
  });

  test("差分マージ後のストア状態が全量取得と一致し、ペイロードは変化分に比例する", async () => {
    // ベースライン: 当日バッファへ保存・解析し、チャンクの updatedAt を過去へ倒す
    // （同一ミリ秒に潰れるテスト実行でも「以後の変更だけが新しい」状況を作る）
    const date = await json<Chunk>(
      await app.request(post("/api/chunks/date", { date: "2026-07-05" })),
    );
    await json(
      await app.request(
        put(`/api/chunks/${date.id}/children`, { converted: "きょうははれ。\nさんぽした。" }),
      ),
    );
    await analysis.settle();
    await db.update(chunks).set({ updatedAt: "2020-01-01T00:00:00.000Z" });
    const full0 = await json<GraphData>(await app.request("/api/graph"));

    // 変更: コンテナ行の追加 → その中へ保存 → 手動リンク → rename → 解析
    const saved = await json<SaveChildrenResponse>(
      await app.request(
        put(`/api/chunks/${date.id}/children`, {
          converted: "きょうははれ。\nさんぽした。\n調査\n",
        }),
      ),
    );
    const container = saved.children.at(-1);
    if (container === undefined) throw new Error("seed 不足");
    const inNested = await json<SaveChildrenResponse>(
      await app.request(
        put(`/api/chunks/${container.id}/children`, { converted: "変換辞書を調べた。\n" }),
      ),
    );
    const a0 = full0.nodes.find((x) => x.parentId === date.id)?.id;
    const b0 = inNested.children[0]?.id;
    if (a0 === undefined || b0 === undefined) throw new Error("seed 不足");
    await json(await app.request(post("/api/links", { from: b0, to: a0 })));
    await app.request(patch(`/api/chunks/${container.id}`, { content: "設計" }));
    await analysis.settle();

    const full1 = await json<GraphData>(await app.request("/api/graph"));

    // 差分ノードは「そのパスで変化した分」だけ（既存 2 チャンクの再送は
    // 保存時の upsert bump 由来のみ許容 = ここでは updatedAt を倒してから触っていない a0 以外）。
    // クライアント側の差分マージ（mergeDelta）は #44 で liveQuery に置換され消滅。
    // このルート自体の撤去は #45（それまではサーバ挙動のみ検証する）
    const sinceMid = await json<GraphDelta>(
      await app.request("/api/graph?since=2025-01-01T00:00:00.000Z"),
    );
    expect(sinceMid.nodes.map((x) => x.id)).toContain(b0);
    expect(sinceMid.nodes.map((x) => x.id)).not.toContain(date.id);

    expect(full1.nodes.find((x) => x.id === container.id)?.content).toBe("設計");
  });

  test("related は embedder なしでは空", async () => {
    const date = await json<Chunk>(await app.request(post("/api/chunks/date", {})));
    const related = await json<{ items: unknown[] }>(
      await app.request(`/api/chunks/${date.id}/related`),
    );
    expect(related.items).toEqual([]);
  });
});

describe("セキュリティヘッダ（#28 / #43）", () => {
  test("全レスポンスに厳格 CSP（default-src 'self'）が付き、CORS ヘッダは付与しない", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // libsodium の WASM 初期化に必要な最小限のみ script-src へ追加する
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 同一オリジンのみ: CORS を明示的に開放しない
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
