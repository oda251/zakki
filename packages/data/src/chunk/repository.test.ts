import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { chunks } from "@zakki/data/db/schema.ts";
import {
  deleteChunk,
  getChunk,
  getDateChunk,
  getOrCreateDateChunk,
  listChildren,
  listDateChunks,
  saveChildren,
  updateChunkContent,
} from "./repository.ts";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("getOrCreateDateChunk", () => {
  test("初回は作成し、以後は同じ行を返す（冪等・1 日 1 件）", async () => {
    const first = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const second = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    expect(first.id).toBe(second.id);
    expect(first.parentId).toBeNull();
    expect(first.date).toBe("2026-07-06");
    // content は date と同値の平文（docs/CHUNKS.md §日付チャンク）
    expect(first.content).toBe("2026-07-06");
    expect(await db.select().from(chunks)).toHaveLength(1);
  });

  test("無ければ getDateChunk は null", async () => {
    expect((await getDateChunk(db, "2026-07-06"))._unsafeUnwrap()).toBeNull();
  });
});

describe("saveChildren", () => {
  test("(parent, position) キーで upsert し、既存 id を保つ", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const first = (
      await saveChildren(db, root.id, [{ content: "一。" }, { content: "二。" }])
    )._unsafeUnwrap();
    const second = (
      await saveChildren(db, root.id, [{ content: "一。" }, { content: "二改。" }])
    )._unsafeUnwrap();
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
    expect(second.map((c) => c.content)).toEqual(["一。", "二改。"]);
  });

  test("余剰 position は削除される", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    (await saveChildren(db, root.id, [{ content: "一。" }, { content: "二。" }]))._unsafeUnwrap();
    const shrunk = (await saveChildren(db, root.id, [{ content: "一。" }]))._unsafeUnwrap();
    expect(shrunk).toHaveLength(1);
    expect((await listChildren(db, root.id))._unsafeUnwrap()).toHaveLength(1);
  });

  test("余剰行の削除は子孫ごと cascade で消える（投影の破壊性, docs/CHUNKS.md）", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const [container] = (await saveChildren(db, root.id, [{ content: "調査" }]))._unsafeUnwrap();
    if (container === undefined) throw new Error("seed 不足");
    (await saveChildren(db, container.id, [{ content: "中身。" }]))._unsafeUnwrap();

    (await saveChildren(db, root.id, []))._unsafeUnwrap();
    expect(await db.select().from(chunks)).toHaveLength(1); // 日付チャンクのみ残る
  });

  test("別の親のチャンクには影響しない", async () => {
    const a = (await getOrCreateDateChunk(db, "2026-07-05"))._unsafeUnwrap();
    const b = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    (await saveChildren(db, a.id, [{ content: "あ。" }]))._unsafeUnwrap();
    (await saveChildren(db, b.id, [{ content: "い。" }]))._unsafeUnwrap();
    (await saveChildren(db, b.id, []))._unsafeUnwrap();
    expect((await listChildren(db, a.id))._unsafeUnwrap().map((c) => c.content)).toEqual(["あ。"]);
  });
});

describe("updateChunkContent", () => {
  test("本文を書き換えて updatedAt を進める", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const [chunk] = (
      await saveChildren(db, root.id, [{ content: "一。" }], "2020-01-01T00:00:00.000Z")
    )._unsafeUnwrap();
    if (chunk === undefined) throw new Error("seed 不足");
    (await updateChunkContent(db, chunk.id, "改。"))._unsafeUnwrap();
    const after = (await getChunk(db, chunk.id))._unsafeUnwrap();
    expect(after?.content).toBe("改。");
    expect(after !== null && after.updatedAt > chunk.updatedAt).toBe(true);
  });

  test("日付チャンクの content は書き換えられない", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const result = await updateChunkContent(db, root.id, "改名");
    expect(result.isErr()).toBe(true);
  });
});

describe("deleteChunk", () => {
  test("子孫ごと削除する（自己参照 FK cascade）", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    const [container] = (await saveChildren(db, root.id, [{ content: "調査" }]))._unsafeUnwrap();
    if (container === undefined) throw new Error("seed 不足");
    (await saveChildren(db, container.id, [{ content: "中身。" }]))._unsafeUnwrap();

    (await deleteChunk(db, container.id))._unsafeUnwrap();
    const rows = await db.select().from(chunks);
    expect(rows.map((c) => c.id)).toEqual([root.id]);
  });
});

describe("listDateChunks", () => {
  test("date 昇順で返す", async () => {
    (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    (await getOrCreateDateChunk(db, "2026-07-01"))._unsafeUnwrap();
    const dates = (await listDateChunks(db))._unsafeUnwrap().map((c) => c.date);
    expect(dates).toEqual(["2026-07-01", "2026-07-06"]);
  });
});

describe("listChildren", () => {
  test("position 順で返す", async () => {
    const root = (await getOrCreateDateChunk(db, "2026-07-06"))._unsafeUnwrap();
    (await saveChildren(db, root.id, [{ content: "一。" }, { content: "二。" }]))._unsafeUnwrap();
    // position を逆順で引いても順序が保たれることを確認するため直接更新はしない
    const children = (await listChildren(db, root.id))._unsafeUnwrap();
    expect(children.map((c) => [c.position, c.content])).toEqual([
      [0, "一。"],
      [1, "二。"],
    ]);
    expect(children.every((c) => c.parentId === root.id)).toBe(true);
  });

  test("getChunk は無い id で null", async () => {
    expect((await getChunk(db, 999))._unsafeUnwrap()).toBeNull();
  });
});
