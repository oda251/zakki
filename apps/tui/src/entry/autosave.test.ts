import { describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { localDate, persistEntry } from "./autosave.ts";

let db: Db;

describe("persistEntry（自動保存の入口）", () => {
  test("converted からチャンクを再生成して保存する", async () => {
    db = await createDb(":memory:");
    const saved = (
      await persistEntry(db, {
        date: "2026-06-12",
        raw: "hare.Claude tohanashita.",
        converted: "はれ。Claudeとはなした。",
      })
    )._unsafeUnwrap();

    expect(saved.chunks.map((c) => c.content)).toEqual(["はれ。", "Claudeとはなした。"]);
  });
});

describe("localDate", () => {
  test("ローカル日付を YYYY-MM-DD で返す", () => {
    expect(localDate(new Date(2026, 5, 12, 23, 59))).toBe("2026-06-12");
  });
});
