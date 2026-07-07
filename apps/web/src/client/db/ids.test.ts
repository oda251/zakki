import { describe, expect, test } from "bun:test";
import { dateChunkId, docId, newDocId, numId } from "@zakki/web/client/db/ids.ts";

/**
 * issue #44: RxDB doc id（string）と UI id（number）の変換・クライアント採番。
 * サーバ採番（autoincrement）が無い RxDB 世界では id はクライアントが振る。
 */
describe("docId / numId", () => {
  test("round-trip する", () => {
    expect(docId(42)).toBe("42");
    expect(numId("42")).toBe(42);
    expect(numId(docId(1_726_000_000_000_123))).toBe(1_726_000_000_000_123);
  });
});

describe("newDocId", () => {
  test("連続呼び出しで一意・Number 安全な数値文字列を返す", () => {
    const ids = Array.from({ length: 100 }, () => newDocId());
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) {
      const n = Number(id);
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(String(n)).toBe(id);
    }
  });
});

describe("dateChunkId", () => {
  test("同じ日付で決定的・日付が違えば異なる", () => {
    expect(dateChunkId("2026-07-07")).toBe(dateChunkId("2026-07-07"));
    expect(dateChunkId("2026-07-07")).not.toBe(dateChunkId("2026-07-08"));
    expect(Number.isSafeInteger(numId(dateChunkId("2026-07-07")))).toBe(true);
  });

  test("newDocId（Date.now 起点）と衝突しない帯域にある", () => {
    expect(numId(dateChunkId("2026-07-07"))).toBeLessThan(numId(newDocId()));
  });
});
