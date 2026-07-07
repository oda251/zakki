import { beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { links } from "@zakki/data/db/schema.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import { addManualLink } from "./repository.ts";

let db: Db;
let chunkIds: number[];

beforeEach(async () => {
  db = await createDb(":memory:");
  const { chunks } = await seedDayChunks(db, "2026-07-05", ["一。", "二。", "三。"]);
  chunkIds = chunks.map((c) => c.id);
});

describe("addManualLink", () => {
  test("from<to へ正規化して origin=manual で保存する", async () => {
    const [a, b] = chunkIds;
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    (await addManualLink(db, b, a))._unsafeUnwrap(); // 逆順で渡しても
    const rows = await db.select().from(links);
    expect(rows).toEqual([{ fromChunkId: a, toChunkId: b, score: 1, origin: "manual" }]);
  });

  test("重複は no-op（既存 auto リンクも上書きしない）", async () => {
    const [a, b] = chunkIds;
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    await db.insert(links).values({ fromChunkId: a, toChunkId: b, score: 0.5, origin: "auto" });
    (await addManualLink(db, a, b))._unsafeUnwrap();
    const rows = await db.select().from(links);
    expect(rows).toEqual([{ fromChunkId: a, toChunkId: b, score: 0.5, origin: "auto" }]);
  });

  test("自己リンク（a === b）は no-op", async () => {
    const [a] = chunkIds;
    if (a === undefined) throw new Error("seed 不足");
    (await addManualLink(db, a, a))._unsafeUnwrap();
    expect(await db.select().from(links)).toHaveLength(0);
  });
});
