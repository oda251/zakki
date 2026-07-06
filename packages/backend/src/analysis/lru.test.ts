import { describe, expect, test } from "bun:test";
import { LruCache } from "./lru.ts";

describe("LruCache", () => {
  test("上限を超えて挿入してもサイズが上限を超えない", () => {
    const cache = new LruCache<string, number>(3);
    for (let i = 0; i < 100; i += 1) {
      cache.set(`key-${i}`, i);
      expect(cache.size).toBeLessThanOrEqual(3);
    }
    expect(cache.size).toBe(3);
  });

  test("上限超過時は最も使われていないエントリから捨てる", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // a を最近使った側へ
    cache.set("c", 3); // b が追い出される
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  test("同一キーの再 set はサイズを増やさず値を更新する", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("a", 10);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBe(10);
  });
});
