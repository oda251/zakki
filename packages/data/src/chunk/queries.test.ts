import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { chunks, chunkTags, links, tags } from "@zakki/data/db/schema.ts";
import { getOrCreateDateChunk, saveChildren } from "./repository.ts";
import {
  countTags,
  dailySentiment,
  getChunkContext,
  listChunksByIds,
  listChunksWithDate,
  listLinksByChunk,
  listTagsByChunk,
} from "./queries.ts";

let db: Db;

/** 日付チャンク + 子チャンク列を seed し、子の id 列を返す */
async function seedDay(date: string, contents: string[]): Promise<number[]> {
  const root = (await getOrCreateDateChunk(db, date))._unsafeUnwrap();
  const saved = (
    await saveChildren(
      db,
      root.id,
      contents.map((content) => ({ content })),
    )
  )._unsafeUnwrap();
  return saved.map((c) => c.id);
}

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("listChunksWithDate", () => {
  test("date は祖先の日付チャンクから導出し、日付チャンク自身は含めない", async () => {
    const [a] = await seedDay("2026-07-05", ["一。"]);
    if (a === undefined) throw new Error("seed 不足");
    // 入れ子: コンテナの子も同じ root date を継承する
    const [container] = (
      await saveChildren(db, (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap().id, [
        { content: "調査" },
      ])
    )._unsafeUnwrap();
    if (container === undefined) throw new Error("seed 不足");
    const [nested] = (
      await saveChildren(db, container.id, [{ content: "深い。" }])
    )._unsafeUnwrap();
    if (nested === undefined) throw new Error("seed 不足");

    const all = (await listChunksWithDate(db))._unsafeUnwrap();
    expect(all.map((c) => [c.content, c.date])).toEqual([
      ["一。", "2026-07-05"],
      ["調査", "2026-07-06"],
      ["深い。", "2026-07-06"],
    ]);
    expect(all.find((c) => c.id === nested.id)?.parentId).toBe(container.id);
  });

  test("since 指定は updatedAt >= since の行だけ返す（境界を含む）", async () => {
    const [a, b] = await seedDay("2026-07-05", ["一。", "二。"]);
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    await db.update(chunks).set({ updatedAt: "2020-01-01T00:00:00.000Z" }).where(eq(chunks.id, a));
    await db.update(chunks).set({ updatedAt: "2026-01-01T00:00:00.000Z" }).where(eq(chunks.id, b));
    const since = "2026-01-01T00:00:00.000Z";
    const rows = (await listChunksWithDate(db, since))._unsafeUnwrap();
    expect(rows.map((c) => c.id)).toEqual([b]);
  });
});

describe("listChunksByIds", () => {
  test("指定 id のみ日付付きで返す（空は空配列）", async () => {
    const [a, b] = await seedDay("2026-07-05", ["一。", "二。"]);
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    const rows = (await listChunksByIds(db, [b]))._unsafeUnwrap();
    expect(rows.map((c) => [c.id, c.content, c.date])).toEqual([[b, "二。", "2026-07-05"]]);
    expect((await listChunksByIds(db, []))._unsafeUnwrap()).toEqual([]);
  });
});

describe("getChunkContext", () => {
  test("一覧順の前後 ±radius を返す", async () => {
    const ids = await seedDay("2026-07-05", ["一。", "二。", "三。", "四。"]);
    const target = ids[2];
    if (target === undefined) throw new Error("seed 不足");
    const ctx = (await getChunkContext(db, target, 1))._unsafeUnwrap();
    expect(ctx.map((c) => c.content)).toEqual(["二。", "三。", "四。"]);
  });

  test("見つからなければ空", async () => {
    expect((await getChunkContext(db, 999, 1))._unsafeUnwrap()).toEqual([]);
  });
});

describe("listTagsByChunk / countTags", () => {
  test("スコア降順のタグ名列と出現数を返す", async () => {
    const [a, b] = await seedDay("2026-07-05", ["一。", "二。"]);
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    const now = new Date().toISOString();
    const [t1] = await db
      .insert(tags)
      .values({ name: "旅行", nameFingerprint: "旅行", createdAt: now })
      .returning();
    const [t2] = await db
      .insert(tags)
      .values({ name: "仕事", nameFingerprint: "仕事", createdAt: now })
      .returning();
    if (t1 === undefined || t2 === undefined) throw new Error("seed 不足");
    await db.insert(chunkTags).values([
      { chunkId: a, tagId: t1.id, score: 0.2 },
      { chunkId: a, tagId: t2.id, score: 0.9 },
      { chunkId: b, tagId: t1.id, score: 0.5 },
    ]);
    const byChunk = (await listTagsByChunk(db))._unsafeUnwrap();
    expect(byChunk.get(a)).toEqual(["仕事", "旅行"]);
    expect(countTags(byChunk)).toEqual(
      new Map([
        ["旅行", 2],
        ["仕事", 1],
      ]),
    );
    expect(countTags(byChunk, [b])).toEqual(new Map([["旅行", 1]]));
  });
});

describe("dailySentiment", () => {
  test("root date ごとに polarity を集計する（未算出は scored から除外）", async () => {
    const [a, b] = await seedDay("2026-07-05", ["嬉しい。", "普通。"]);
    if (a === undefined || b === undefined) throw new Error("seed 不足");
    await seedDay("2026-07-06", ["別日。"]);
    await db.update(chunks).set({ polarity: 0.5 }).where(eq(chunks.id, a));
    const rows = (await dailySentiment(db))._unsafeUnwrap();
    expect(rows).toHaveLength(2);
    const day1 = rows[0];
    expect(day1?.date).toBe("2026-07-05");
    expect(day1?.chunks).toBe(2);
    expect(day1?.scored).toBe(1);
    expect(day1?.average).toBe(0.5);
    expect(day1?.positive).toBe(1);
  });
});

describe("listLinksByChunk", () => {
  test("双方向・スコア降順で返す", async () => {
    const [a, b, c] = await seedDay("2026-07-05", ["一。", "二。", "三。"]);
    if (a === undefined || b === undefined || c === undefined) throw new Error("seed 不足");
    await db.insert(links).values([
      { fromChunkId: a, toChunkId: b, score: 0.5, origin: "auto" },
      { fromChunkId: a, toChunkId: c, score: 0.9, origin: "auto" },
    ]);
    const byChunk = (await listLinksByChunk(db))._unsafeUnwrap();
    expect(byChunk.get(a)).toEqual([c, b]);
    expect(byChunk.get(b)).toEqual([a]);
  });
});
