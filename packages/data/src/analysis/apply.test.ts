import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { chunks, chunkTags, links } from "@zakki/data/db/schema.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import type { WritePlan } from "./apply.ts";
import { applyAnalysisPlan } from "./apply.ts";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
});

const NOW = "2026-07-08T00:00:00.000Z";

describe("applyAnalysisPlan", () => {
  test("plan の read 後に消えたチャンクへの書き込みはスキップする（issue #58 項目 6）", async () => {
    const { chunks: saved } = await seedDayChunks(db, "2026-07-06", ["残る。", "消える。"]);
    const [kept, gone] = saved;
    if (kept === undefined || gone === undefined) throw new Error("seed 不足");

    const plan: WritePlan = {
      tagNames: new Set(["備忘"]),
      tagRewrites: [
        { chunkId: kept.id, tags: [{ name: "備忘", score: 1 }] },
        { chunkId: gone.id, tags: [{ name: "備忘", score: 1 }] },
      ],
      relinkChunkIds: [kept.id, gone.id],
      insertLinks: [{ fromChunkId: kept.id, toChunkId: gone.id, score: 0.9 }],
      polarityWrites: [
        { chunkId: kept.id, polarity: 1, bump: false },
        { chunkId: gone.id, polarity: -1, bump: false },
      ],
    };

    // plan 構築（解析サービスの大 SELECT）と適用の間の並走削除（saveChildren 等）を再現する
    await db.delete(chunks).where(eq(chunks.id, gone.id));

    // FK 違反でパス全体が失敗せず、現存チャンク分だけが書き込まれる
    await applyAnalysisPlan(db, plan, NOW);

    const tagRows = await db.select().from(chunkTags);
    expect(tagRows.map((r) => r.chunkId)).toEqual([kept.id]);
    // 片端が消えたリンクは挿入しない
    expect(await db.select().from(links)).toHaveLength(0);
    const [keptRow] = await db.select().from(chunks).where(eq(chunks.id, kept.id));
    expect(keptRow?.polarity).toBe(1);
  });

  test("全端点が現存する plan はそのまま適用される", async () => {
    const { chunks: saved } = await seedDayChunks(db, "2026-07-06", ["一。", "二。"]);
    const [a, b] = saved;
    if (a === undefined || b === undefined) throw new Error("seed 不足");

    const plan: WritePlan = {
      tagNames: new Set(["備忘"]),
      tagRewrites: [{ chunkId: a.id, tags: [{ name: "備忘", score: 1 }] }],
      relinkChunkIds: [a.id, b.id],
      insertLinks: [{ fromChunkId: a.id, toChunkId: b.id, score: 0.9 }],
      polarityWrites: [{ chunkId: b.id, polarity: -1, bump: false }],
    };
    await applyAnalysisPlan(db, plan, NOW);

    expect((await db.select().from(chunkTags)).map((r) => r.chunkId)).toEqual([a.id]);
    expect(await db.select().from(links)).toHaveLength(1);
    const [bRow] = await db.select().from(chunks).where(eq(chunks.id, b.id));
    expect(bRow?.polarity).toBe(-1);
  });
});
