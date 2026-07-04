import { describe, expect, test } from "bun:test";
import type { ChunkWithDate } from "@zakki/data/entry/queries.ts";
import { buildIndex, searchChunks } from "./index.ts";

const chunks: ChunkWithDate[] = [
  {
    id: 1,
    entryId: 1,
    sessionId: 1,
    position: 0,
    content: "自動保存の仕組みを実装した。",
    date: "2026-06-12",
    polarity: null,
  },
  {
    id: 2,
    entryId: 1,
    sessionId: 1,
    position: 1,
    content: "天気がよかったので散歩した。",
    date: "2026-06-12",
    polarity: null,
  },
  {
    id: 3,
    entryId: 2,
    sessionId: 1,
    position: 0,
    content: "Claudeと変換エンジンの話をした。",
    date: "2026-06-13",
    polarity: null,
  },
];

describe("全文検索（バイグラム + 読み索引）", () => {
  const index = buildIndex(chunks);

  test("ローマ字クエリで漢字本文に当たる", () => {
    const hits = searchChunks(index, "jidouhozon");
    expect(hits.map((h) => h.id)).toEqual([1]);
  });

  test("かな部分一致でも当たる", () => {
    const hits = searchChunks(index, "sanpo");
    expect(hits.map((h) => h.id)).toEqual([2]);
  });

  test("英単語（大文字始まりパススルー）でも当たる", () => {
    const hits = searchChunks(index, "Claude");
    expect(hits.map((h) => h.id)).toEqual([3]);
  });

  test("空クエリは空結果", () => {
    expect(searchChunks(index, "")).toEqual([]);
    expect(searchChunks(index, "   ")).toEqual([]);
  });

  test("該当なしは空結果", () => {
    expect(searchChunks(index, "ryokou")).toEqual([]);
  });
});
