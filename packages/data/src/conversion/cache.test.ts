import { beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { loadConversionCache, saveConversion } from "./cache.ts";

let db: Db;

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("変換キャッシュの永続化", () => {
  test("保存した変換を読み戻せる", async () => {
    (await saveConversion(db, "はれ。", "晴れ。"))._unsafeUnwrap();
    (await saveConversion(db, "さんぽ", "散歩"))._unsafeUnwrap();
    const cache = (await loadConversionCache(db))._unsafeUnwrap();
    expect(cache.get("はれ。")).toBe("晴れ。");
    expect(cache.get("さんぽ")).toBe("散歩");
  });

  test("同じかなは上書きされる（冪等な upsert）", async () => {
    (await saveConversion(db, "はれ。", "貼れ。"))._unsafeUnwrap();
    (await saveConversion(db, "はれ。", "晴れ。"))._unsafeUnwrap();
    const cache = (await loadConversionCache(db))._unsafeUnwrap();
    expect(cache.get("はれ。")).toBe("晴れ。");
    expect(cache.size).toBe(1);
  });

  test("空 DB は空マップ", async () => {
    expect((await loadConversionCache(db))._unsafeUnwrap().size).toBe(0);
  });
});
