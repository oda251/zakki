import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { getEntryWithChunks, getOrCreateEntry, saveSnapshot } from "./repository.ts";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("getOrCreateEntry", () => {
  test("なければ作成し、あれば同じものを返す", async () => {
    const first = (await getOrCreateEntry(db, "2026-06-12"))._unsafeUnwrap();
    const second = (await getOrCreateEntry(db, "2026-06-12"))._unsafeUnwrap();
    expect(second.id).toBe(first.id);
    expect(first.raw).toBe("");
  });
});

describe("saveSnapshot", () => {
  test("エントリ本文とチャンクを保存する", async () => {
    const saved = (
      await saveSnapshot(db, {
        date: "2026-06-12",
        raw: "kyouhahare.sanposhita.",
        converted: "きょうははれ。さんぽした。",
        chunks: [{ content: "きょうははれ。" }, { content: "さんぽした。" }],
      })
    )._unsafeUnwrap();

    expect(saved.entry.converted).toBe("きょうははれ。さんぽした。");
    expect(saved.chunks.map((c) => c.position)).toEqual([0, 1]);
  });

  test("再保存で (entry, position) を upsert し余剰チャンクを削除する", async () => {
    const date = "2026-06-12";
    (
      await saveSnapshot(db, {
        date,
        raw: "a",
        converted: "あ",
        chunks: [{ content: "一" }, { content: "二" }, { content: "三" }],
      })
    )._unsafeUnwrap();

    const second = (
      await saveSnapshot(db, {
        date,
        raw: "b",
        converted: "い",
        chunks: [{ content: "改" }],
      })
    )._unsafeUnwrap();

    expect(second.chunks).toHaveLength(1);
    const loaded = (await getEntryWithChunks(db, date))._unsafeUnwrap();
    expect(loaded?.chunks.map((c) => c.content)).toEqual(["改"]);
    expect(loaded?.entry.raw).toBe("b");
  });

  test("entry の作成日時は upsert で維持される", async () => {
    const date = "2026-06-12";
    const first = (
      await saveSnapshot(
        db,
        { date, raw: "a", converted: "あ", chunks: [] },
        "2026-06-12T00:00:00.000Z",
      )
    )._unsafeUnwrap();
    const second = (
      await saveSnapshot(
        db,
        { date, raw: "b", converted: "い", chunks: [] },
        "2026-06-12T01:00:00.000Z",
      )
    )._unsafeUnwrap();

    expect(second.entry.createdAt).toBe(first.entry.createdAt);
    expect(second.entry.updatedAt).toBe("2026-06-12T01:00:00.000Z");
  });
});

describe("getEntryWithChunks", () => {
  test("存在しない日付は null", async () => {
    expect((await getEntryWithChunks(db, "1970-01-01"))._unsafeUnwrap()).toBeNull();
  });
});
