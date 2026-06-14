import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@/db/client.ts";
import { saveSnapshot } from "./repository.ts";
import { countTags, getChunkContext, listChunksWithDate } from "./queries.ts";

let db: Db;

beforeEach(() => {
  db = createDb(":memory:");
});

describe("countTags", () => {
  const tagsByChunk = new Map<number, string[]>([
    [1, ["変換", "実装"]],
    [2, ["変換"]],
    [3, ["散歩"]],
  ]);

  test("全チャンクのタグ出現数を数える", () => {
    expect(countTags(tagsByChunk)).toEqual(
      new Map([
        ["変換", 2],
        ["実装", 1],
        ["散歩", 1],
      ]),
    );
  });

  test("chunkIds 指定時はその部分集合のみ数える", () => {
    expect(countTags(tagsByChunk, [1, 3])).toEqual(
      new Map([
        ["変換", 1],
        ["実装", 1],
        ["散歩", 1],
      ]),
    );
  });
});

describe("getChunkContext", () => {
  beforeEach(() => {
    saveSnapshot(db, {
      date: "2026-06-13",
      raw: "",
      converted: "",
      chunks: [{ content: "一" }, { content: "二" }, { content: "三" }, { content: "四" }],
    })._unsafeUnwrap();
  });

  const idOf = (content: string): number => {
    const chunk = listChunksWithDate(db)
      ._unsafeUnwrap()
      .find((c) => c.content === content);
    if (chunk === undefined) {
      throw new Error(`setup: ${content} not found`);
    }
    return chunk.id;
  };

  test("当該チャンクとその前後（±radius）を返す", () => {
    const ctx = getChunkContext(db, idOf("二"), 1)._unsafeUnwrap();
    expect(ctx.map((c) => c.content)).toEqual(["一", "二", "三"]);
  });

  test("先頭は前が無くても範囲内で返す", () => {
    const ctx = getChunkContext(db, idOf("一"), 1)._unsafeUnwrap();
    expect(ctx.map((c) => c.content)).toEqual(["一", "二"]);
  });

  test("存在しない id は空", () => {
    expect(getChunkContext(db, 9999, 1)._unsafeUnwrap()).toEqual([]);
  });
});
