import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@/db/client.ts";
import { loadConversionCache, saveConversion } from "./cache.ts";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});

describe("変換キャッシュの永続化", () => {
  test("保存した変換を読み戻せる", () => {
    saveConversion(db, "はれ。", "晴れ。")._unsafeUnwrap();
    saveConversion(db, "さんぽ", "散歩")._unsafeUnwrap();
    const cache = loadConversionCache(db)._unsafeUnwrap();
    expect(cache.get("はれ。")).toBe("晴れ。");
    expect(cache.get("さんぽ")).toBe("散歩");
  });

  test("同じかなは上書きされる（冪等な upsert）", () => {
    saveConversion(db, "はれ。", "貼れ。")._unsafeUnwrap();
    saveConversion(db, "はれ。", "晴れ。")._unsafeUnwrap();
    const cache = loadConversionCache(db)._unsafeUnwrap();
    expect(cache.get("はれ。")).toBe("晴れ。");
    expect(cache.size).toBe(1);
  });

  test("空 DB は空マップ", () => {
    expect(loadConversionCache(db)._unsafeUnwrap().size).toBe(0);
  });
});
