import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { chunks, links } from "@zakki/data/db/schema.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { createSession, setSessionTags } from "@zakki/data/session/repository.ts";
import { getGraph, getGraphDelta } from "./queries.ts";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("getGraph", () => {
  test("ノード・エッジ・セッションを束ねて返す", async () => {
    const date = "2026-07-05";
    const named = (await createSession(db, { name: "調査", date }))._unsafeUnwrap();
    (await setSessionTags(db, named.id, ["web"]))._unsafeUnwrap();

    const def = (
      await saveSnapshot(db, {
        date,
        raw: "",
        converted: "一。二。",
        chunks: [{ content: "一。" }, { content: "二。" }],
      })
    )._unsafeUnwrap();
    const inNamed = (
      await saveSnapshot(db, {
        date,
        sessionId: named.id,
        raw: "",
        converted: "三。",
        chunks: [{ content: "三。" }],
      })
    )._unsafeUnwrap();

    const [c0, c1] = def.chunks;
    if (c0 === undefined || c1 === undefined) throw new Error("chunks 不足");
    await db
      .insert(links)
      .values({ fromChunkId: c0.id, toChunkId: c1.id, score: 0.9, origin: "auto" });

    const graph = (await getGraph(db))._unsafeUnwrap();

    expect(graph.nodes).toHaveLength(3);
    const namedNode = graph.nodes.find((n) => n.sessionId === named.id);
    expect(namedNode?.sessionName).toBe("調査");
    expect(namedNode?.content).toBe("三。");
    const defNode = graph.nodes.find((n) => n.id === c0.id);
    expect(defNode?.sessionName).toBeNull();
    expect(defNode?.sessionId).toBe(def.entry.sessionId);

    expect(graph.edges).toEqual([{ from: c0.id, to: c1.id, score: 0.9, origin: "auto" }]);

    expect(graph.sessions).toHaveLength(2);
    expect(graph.sessions.find((s) => s.id === named.id)?.tags).toEqual(["web"]);
    expect(inNamed.entry.sessionId).toBe(named.id);
  });

  test("空 DB では空のグラフ（version は空文字）", async () => {
    const graph = (await getGraph(db))._unsafeUnwrap();
    expect(graph).toEqual({ version: "", nodes: [], edges: [], sessions: [] });
  });
});

const OLD = "2020-01-01T00:00:00.000Z";
const MID = "2023-01-01T00:00:00.000Z";
const NEW = "2026-01-01T00:00:00.000Z";

/** 2 チャンク（updatedAt = OLD / NEW）+ auto リンク 1 本を seed する */
async function seedTwoChunks(): Promise<[number, number]> {
  const saved = (
    await saveSnapshot(db, {
      date: "2026-07-05",
      raw: "",
      converted: "一。二。",
      chunks: [{ content: "一。" }, { content: "二。" }],
    })
  )._unsafeUnwrap();
  const [c0, c1] = saved.chunks;
  if (c0 === undefined || c1 === undefined) throw new Error("chunks 不足");
  await db
    .insert(links)
    .values({ fromChunkId: c0.id, toChunkId: c1.id, score: 0.9, origin: "auto" });
  await db.update(chunks).set({ updatedAt: OLD }).where(eq(chunks.id, c0.id));
  await db.update(chunks).set({ updatedAt: NEW }).where(eq(chunks.id, c1.id));
  return [c0.id, c1.id];
}

describe("getGraph の version", () => {
  test("チャンクの最大 updatedAt を version として返す", async () => {
    await seedTwoChunks();
    const graph = (await getGraph(db))._unsafeUnwrap();
    expect(graph.version).toBe(NEW);
  });
});

describe("getGraphDelta", () => {
  test("since 以降に更新されたチャンクだけ nodes に含む（エッジ・セッション・生存 id は全量）", async () => {
    const [id0, id1] = await seedTwoChunks();

    const delta = (await getGraphDelta(db, MID))._unsafeUnwrap();

    expect(delta.nodes.map((n) => n.id)).toEqual([id1]);
    expect(delta.nodes[0]?.content).toBe("二。");
    expect(delta.aliveNodeIds).toEqual([id0, id1]);
    expect(delta.edges).toEqual([{ from: id0, to: id1, score: 0.9, origin: "auto" }]);
    expect(delta.sessions).toHaveLength(1);
    expect(delta.version).toBe(NEW);
  });

  test("since と同時刻（同一ミリ秒）の更新は取りこぼさない（>= 比較）", async () => {
    const [, id1] = await seedTwoChunks();
    const delta = (await getGraphDelta(db, NEW))._unsafeUnwrap();
    expect(delta.nodes.map((n) => n.id)).toEqual([id1]);
  });

  test("削除されたチャンクは aliveNodeIds から消える", async () => {
    const [id0, id1] = await seedTwoChunks();
    await db.delete(chunks).where(eq(chunks.id, id1));
    const delta = (await getGraphDelta(db, MID))._unsafeUnwrap();
    expect(delta.aliveNodeIds).toEqual([id0]);
    expect(delta.nodes).toEqual([]);
  });
});
