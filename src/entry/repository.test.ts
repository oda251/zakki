import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@/db/client.ts";
import { localDate, persistEntry } from "./autosave.ts";
import { getEntryWithChunks, getOrCreateEntry, saveSnapshot } from "./repository.ts";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});

describe("getOrCreateEntry", () => {
  test("なければ作成し、あれば同じものを返す", () => {
    const first = getOrCreateEntry(db, "2026-06-12")._unsafeUnwrap();
    const second = getOrCreateEntry(db, "2026-06-12")._unsafeUnwrap();
    expect(second.id).toBe(first.id);
    expect(first.raw).toBe("");
  });
});

describe("saveSnapshot", () => {
  test("エントリ本文とチャンクを保存する", () => {
    const saved = saveSnapshot(db, {
      date: "2026-06-12",
      raw: "kyouhahare.sanposhita.",
      converted: "きょうははれ。さんぽした。",
      chunks: [
        { title: "きょうははれ。", content: "きょうははれ。" },
        { title: "さんぽした。", content: "さんぽした。" },
      ],
    })._unsafeUnwrap();

    expect(saved.entry.converted).toBe("きょうははれ。さんぽした。");
    expect(saved.chunks.map((c) => c.position)).toEqual([0, 1]);
  });

  test("再保存で (entry, position) を upsert し余剰チャンクを削除する", () => {
    const date = "2026-06-12";
    saveSnapshot(db, {
      date,
      raw: "a",
      converted: "あ",
      chunks: [
        { title: "一", content: "一" },
        { title: "二", content: "二" },
        { title: "三", content: "三" },
      ],
    })._unsafeUnwrap();

    const second = saveSnapshot(db, {
      date,
      raw: "b",
      converted: "い",
      chunks: [{ title: "改", content: "改" }],
    })._unsafeUnwrap();

    expect(second.chunks).toHaveLength(1);
    const loaded = getEntryWithChunks(db, date)._unsafeUnwrap();
    expect(loaded?.chunks.map((c) => c.content)).toEqual(["改"]);
    expect(loaded?.entry.raw).toBe("b");
  });

  test("entry の作成日時は upsert で維持される", () => {
    const date = "2026-06-12";
    const first = saveSnapshot(
      db,
      { date, raw: "a", converted: "あ", chunks: [] },
      "2026-06-12T00:00:00.000Z",
    )._unsafeUnwrap();
    const second = saveSnapshot(
      db,
      { date, raw: "b", converted: "い", chunks: [] },
      "2026-06-12T01:00:00.000Z",
    )._unsafeUnwrap();

    expect(second.entry.createdAt).toBe(first.entry.createdAt);
    expect(second.entry.updatedAt).toBe("2026-06-12T01:00:00.000Z");
  });
});

describe("persistEntry（自動保存の入口）", () => {
  test("converted からチャンクを再生成して保存する", () => {
    const saved = persistEntry(db, {
      date: "2026-06-12",
      raw: "hare.Claude tohanashita.",
      converted: "はれ。Claudeとはなした。",
    })._unsafeUnwrap();

    expect(saved.chunks.map((c) => c.content)).toEqual(["はれ。", "Claudeとはなした。"]);
  });
});

describe("localDate", () => {
  test("ローカル日付を YYYY-MM-DD で返す", () => {
    expect(localDate(new Date(2026, 5, 12, 23, 59))).toBe("2026-06-12");
  });
});

describe("getEntryWithChunks", () => {
  test("存在しない日付は null", () => {
    expect(getEntryWithChunks(db, "1970-01-01")._unsafeUnwrap()).toBeNull();
  });
});
