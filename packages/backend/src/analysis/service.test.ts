import { beforeEach, describe, expect, test } from "bun:test";
import { eq, isNotNull } from "drizzle-orm";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { chunks } from "@zakki/data/db/schema.ts";
import { getDateChunk, getOrCreateDateChunk, saveChildren } from "@zakki/data/chunk/repository.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import {
  dailySentiment,
  listChunksWithDate,
  listLinksByChunk,
  listTagsByChunk,
} from "@zakki/data/chunk/queries.ts";
import { listUserTagsByChunk, setChunkUserTags } from "@zakki/data/chunk/user-tags.ts";
import { analyzeAll } from "./service.ts";

let db: Db;

async function seed(date: string, contents: string[]): Promise<void> {
  await seedDayChunks(db, date, contents);
}

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("analyzeAll", () => {
  test("タグと関連リンクを永続化する", async () => {
    await seed("2026-06-12", [
      "かな漢字変換の辞書を調べた。",
      "変換エンジンの辞書を組み込んだ。",
      "散歩して天気の話をした。",
    ]);

    const summary = (await analyzeAll(db))._unsafeUnwrap();
    expect(summary.taggedChunks).toBe(3);

    const body = (await listChunksWithDate(db))._unsafeUnwrap();
    const [c1, c2, c3] = body.map((c) => c.id);
    if (c1 === undefined || c2 === undefined || c3 === undefined) throw new Error("seed 不足");

    const tags = (await listTagsByChunk(db))._unsafeUnwrap();
    expect(tags.size).toBe(3);
    expect(tags.get(c1)).toContain("辞書");

    // c1↔c2 は「変換」「辞書」を共有して関連、c3 は孤立
    const links = (await listLinksByChunk(db))._unsafeUnwrap();
    expect(links.get(c1)).toEqual([c2]);
    expect(links.get(c2)).toEqual([c1]);
    expect(links.get(c3)).toBeUndefined();
  });

  test("再実行で冪等（タグ・リンクが重複しない）", async () => {
    await seed("2026-06-12", ["変換辞書の話。", "変換辞書の続き。"]);
    (await analyzeAll(db))._unsafeUnwrap();
    const first = (await listLinksByChunk(db))._unsafeUnwrap();
    (await analyzeAll(db))._unsafeUnwrap();
    const second = (await listLinksByChunk(db))._unsafeUnwrap();
    expect(second).toEqual(first);
  });

  test("ネガポジ極性を永続化し、日ごとに集計できる", async () => {
    await seed("2026-06-12", ["今日は良い天気です。", "最悪だ。つらい。", "コードを書いた。"]);
    (await analyzeAll(db))._unsafeUnwrap();

    const daily = (await dailySentiment(db))._unsafeUnwrap();
    expect(daily).toHaveLength(1);
    const day = daily[0];
    expect(day?.date).toBe("2026-06-12");
    expect(day?.chunks).toBe(3);
    expect(day?.scored).toBe(3);
    expect(day?.positive).toBe(1);
    expect(day?.negative).toBe(1);
    expect(day?.neutral).toBe(1);
    expect(day?.average).toBeCloseTo(0, 5);
  });

  test("日付チャンクは解析対象外（タグも polarity も付かない）", async () => {
    await seed("2026-06-12", ["変換辞書の話。"]);
    (await analyzeAll(db))._unsafeUnwrap();

    const root = (await getDateChunk(db, "2026-06-12"))._unsafeUnwrap();
    if (root === null) throw new Error("日付チャンクが無い");

    // 日付チャンク自身にはタグが付かない
    const tags = (await listTagsByChunk(db))._unsafeUnwrap();
    expect(tags.get(root.id)).toBeUndefined();

    // polarity も算出されない（null のまま）
    const [row] = await db
      .select({ polarity: chunks.polarity })
      .from(chunks)
      .where(eq(chunks.id, root.id));
    expect(row?.polarity).toBeNull();
  });

  test("チャンクが消えたら使われないタグも消える", async () => {
    await seed("2026-06-12", ["特殊な合言葉ペンギン会議。"]);
    (await analyzeAll(db))._unsafeUnwrap();
    await seed("2026-06-12", ["別の内容になった。"]);
    (await analyzeAll(db))._unsafeUnwrap();
    const tags = (await listTagsByChunk(db))._unsafeUnwrap();
    for (const names of tags.values()) {
      expect(names).not.toContain("ペンギン");
    }
  });

  test("manual リンク（自動リンク機能で付与）は analyzeAll の auto 張り替え後も残る", async () => {
    await seed("2026-06-12", ["最初の話。", "全然関係ない別の話。"]);
    const { addManualLink } = await import("@zakki/data/link/repository.ts");
    const chunkRows = (await listChunksWithDate(db))._unsafeUnwrap();
    const [a, b] = chunkRows.map((c) => c.id);
    if (a === undefined || b === undefined) throw new Error("seed 不足");

    (await addManualLink(db, a, b))._unsafeUnwrap();
    (await analyzeAll(db))._unsafeUnwrap();

    const links = (await listLinksByChunk(db))._unsafeUnwrap();
    expect(links.get(a)).toContain(b);
  });

  test("解析結果が変わったチャンクは updatedAt が進み、冪等再実行では進まない", async () => {
    const OLD = "2020-01-01T00:00:00.000Z";
    await seed("2026-06-12", ["変換辞書の話。", "散歩して天気の話をした。"]);

    // 初回解析は polarity null → 値・タグ付与で「変化あり」= 全本文チャンク bump
    // （日付チャンクは解析対象外なので更新されない。ここでも本文チャンクだけを見る）
    await db.update(chunks).set({ updatedAt: OLD }).where(isNotNull(chunks.parentId));
    (await analyzeAll(db))._unsafeUnwrap();
    for (const row of await db
      .select({ updatedAt: chunks.updatedAt })
      .from(chunks)
      .where(isNotNull(chunks.parentId))) {
      expect(row.updatedAt > OLD).toBe(true);
    }

    // 再実行は決定的に同じ結果 = 変化なし → bump しない（差分取得の無駄な再送を防ぐ）
    await db.update(chunks).set({ updatedAt: OLD }).where(isNotNull(chunks.parentId));
    (await analyzeAll(db))._unsafeUnwrap();
    for (const row of await db
      .select({ updatedAt: chunks.updatedAt })
      .from(chunks)
      .where(isNotNull(chunks.parentId))) {
      expect(row.updatedAt).toBe(OLD);
    }
  });

  test("ユーザ明示タグは解析の全消し再挿入・孤立削除に干渉されない", async () => {
    // コンテナチャンク（saveChildren で子を持たせたチャンク）にユーザタグを付ける
    const root = (await getOrCreateDateChunk(db, "2026-06-12"))._unsafeUnwrap();
    const [container] = (await saveChildren(db, root.id, [{ content: "調査" }]))._unsafeUnwrap();
    if (container === undefined) throw new Error("seed 不足");
    (await saveChildren(db, container.id, [{ content: "変換辞書の話。" }]))._unsafeUnwrap();
    (await setChunkUserTags(db, container.id, ["web", "設計"]))._unsafeUnwrap();

    (await analyzeAll(db))._unsafeUnwrap();

    const userTags = (await listUserTagsByChunk(db))._unsafeUnwrap();
    expect(userTags.get(container.id)).toEqual(["web", "設計"]);
  });
});
