import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { links } from "@zakki/data/db/schema.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { createSession, setSessionTags } from "@zakki/data/session/repository.ts";
import { getGraph } from "./queries.ts";

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

  test("空 DB では空のグラフ", async () => {
    const graph = (await getGraph(db))._unsafeUnwrap();
    expect(graph).toEqual({ nodes: [], edges: [], sessions: [] });
  });
});
