import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { chunks, links } from "@zakki/data/db/schema.ts";
import { getOrCreateDateChunk, saveChildren } from "@zakki/data/chunk/repository.ts";
import { setChunkUserTags } from "@zakki/data/chunk/user-tags.ts";
import { getGraph, getGraphDelta } from "./queries.ts";

let db: Db;

const norm = (a: number, b: number) => (a < b ? [a, b] : [b, a]);

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("getGraph", () => {
  test("全ノード（日付チャンク含む）に派生値を付与して返す", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-05"))._unsafeUnwrap();
    const [c0, container] = (
      await saveChildren(db, root.id, [{ content: "一。" }, { content: "調査" }])
    )._unsafeUnwrap();
    if (c0 === undefined || container === undefined) throw new Error("seed 不足");
    const [nested] = (
      await saveChildren(db, container.id, [{ content: "深い。" }])
    )._unsafeUnwrap();
    if (nested === undefined) throw new Error("seed 不足");
    (await setChunkUserTags(db, container.id, ["web"]))._unsafeUnwrap();

    const graph = (await getGraph(db))._unsafeUnwrap();
    expect(graph.nodes).toHaveLength(4);

    const rootNode = graph.nodes.find((n) => n.id === root.id);
    expect(rootNode).toMatchObject({
      parentId: null,
      content: "2026-07-05",
      date: "2026-07-05",
      childCount: 2,
      descendantCount: 3,
    });

    const containerNode = graph.nodes.find((n) => n.id === container.id);
    expect(containerNode).toMatchObject({
      parentId: root.id,
      content: "調査",
      date: "2026-07-05",
      childCount: 1,
      descendantCount: 1,
      userTags: ["web"],
    });

    const leaf = graph.nodes.find((n) => n.id === nested.id);
    expect(leaf).toMatchObject({ childCount: 0, descendantCount: 0, date: "2026-07-05" });
  });

  test("日付チャンク同士は前後最近接の時系列リンク（chrono）で結ぶ", async () => {
    const d1 = (await getOrCreateDateChunk(db, "2026-07-01"))._unsafeUnwrap();
    const d3 = (await getOrCreateDateChunk(db, "2026-07-03"))._unsafeUnwrap();
    // 過去日を後から挿入しても導出なので常に正しい
    const d2 = (await getOrCreateDateChunk(db, "2026-07-02"))._unsafeUnwrap();

    const graph = (await getGraph(db))._unsafeUnwrap();
    const chrono = graph.edges.filter((e) => e.origin === "chrono");
    expect(chrono.map((e) => [e.from, e.to])).toEqual([norm(d1.id, d2.id), norm(d2.id, d3.id)]);
  });

  test("links のエッジと chrono を併載する", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-05"))._unsafeUnwrap();
    const [a, b] = (
      await saveChildren(db, root.id, [{ content: "一。" }, { content: "二。" }])
    )._unsafeUnwrap();
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    await db
      .insert(links)
      .values({ fromChunkId: a.id, toChunkId: b.id, score: 0.9, origin: "auto" });

    const graph = (await getGraph(db))._unsafeUnwrap();
    expect(graph.edges.filter((e) => e.origin === "auto")).toEqual([
      { from: a.id, to: b.id, score: 0.9, origin: "auto" },
    ]);
    // 日付チャンクが 1 つだけなら chrono は無し
    expect(graph.edges.filter((e) => e.origin === "chrono")).toEqual([]);
  });

  test("空 DB では空のグラフ（version は空文字）", async () => {
    const graph = (await getGraph(db))._unsafeUnwrap();
    expect(graph).toEqual({ version: "", nodes: [], edges: [] });
  });
});

const OLD = "2020-01-01T00:00:00.000Z";
const NEW = "2026-01-01T00:00:00.000Z";

describe("getGraphDelta", () => {
  test("since 以降に更新されたノードだけを返し、aliveNodes は派生値付き全量", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-05"))._unsafeUnwrap();
    const [a, b] = (
      await saveChildren(db, root.id, [{ content: "一。" }, { content: "二。" }])
    )._unsafeUnwrap();
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    await db.update(chunks).set({ updatedAt: OLD }).where(eq(chunks.id, a.id));
    await db.update(chunks).set({ updatedAt: OLD }).where(eq(chunks.id, root.id));
    await db.update(chunks).set({ updatedAt: NEW }).where(eq(chunks.id, b.id));

    const delta = (await getGraphDelta(db, NEW))._unsafeUnwrap();
    // since と同時刻（>= 比較）の b だけが nodes に載る
    expect(delta.nodes.map((n) => n.id)).toEqual([b.id]);
    expect(delta.nodes[0]?.content).toBe("二。");
    expect(delta.aliveNodes.map((n) => n.id)).toEqual([root.id, a.id, b.id]);
    // 子の追加は親の updatedAt を動かさないため、派生値は aliveNodes 全量で届く
    expect(delta.aliveNodes.find((n) => n.id === root.id)).toMatchObject({
      childCount: 2,
      descendantCount: 2,
    });
    expect(delta.version).toBe(NEW);
  });

  test("差分適用後 = 全量取得（削除は aliveNodes に無いことで検出できる）", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-05"))._unsafeUnwrap();
    const [a] = (
      await saveChildren(db, root.id, [{ content: "一。" }, { content: "二。" }])
    )._unsafeUnwrap();
    if (a === undefined) throw new Error("seed 不足");
    // 2 件 → 1 件へ縮小（1 件削除）
    (await saveChildren(db, root.id, [{ content: "一。" }]))._unsafeUnwrap();

    const delta = (await getGraphDelta(db, OLD))._unsafeUnwrap();
    const full = (await getGraph(db))._unsafeUnwrap();
    expect(delta.aliveNodes.map((n) => n.id)).toEqual(full.nodes.map((n) => n.id));
    expect(delta.edges).toEqual(full.edges);
    expect(delta.version).toBe(full.version);
  });
});
