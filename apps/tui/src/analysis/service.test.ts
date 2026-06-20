import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { dailySentiment, listLinksByChunk, listTagsByChunk } from "@zakki/data/entry/queries.ts";
import { analyzeAll } from "./service.ts";

let db: Db;

function seed(date: string, contents: string[]): void {
  saveSnapshot(db, {
    date,
    raw: "",
    converted: contents.join(""),
    chunks: contents.map((content) => ({ content })),
  })._unsafeUnwrap();
}

beforeEach(() => {
  db = createDb(":memory:");
});

describe("analyzeAll", () => {
  test("タグと関連リンクを永続化する", () => {
    seed("2026-06-12", [
      "かな漢字変換の辞書を調べた。",
      "変換エンジンの辞書を組み込んだ。",
      "散歩して天気の話をした。",
    ]);

    const summary = analyzeAll(db)._unsafeUnwrap();
    expect(summary.taggedChunks).toBe(3);

    const tags = listTagsByChunk(db)._unsafeUnwrap();
    expect(tags.size).toBe(3);
    expect(tags.get(1)).toContain("辞書");

    // 1↔2 は「変換」「辞書」を共有して関連、3 は孤立
    const links = listLinksByChunk(db)._unsafeUnwrap();
    expect(links.get(1)).toEqual([2]);
    expect(links.get(2)).toEqual([1]);
    expect(links.get(3)).toBeUndefined();
  });

  test("再実行で冪等（タグ・リンクが重複しない）", () => {
    seed("2026-06-12", ["変換辞書の話。", "変換辞書の続き。"]);
    analyzeAll(db)._unsafeUnwrap();
    const first = listLinksByChunk(db)._unsafeUnwrap();
    analyzeAll(db)._unsafeUnwrap();
    const second = listLinksByChunk(db)._unsafeUnwrap();
    expect(second).toEqual(first);
  });

  test("ネガポジ極性を永続化し、日ごとに集計できる", () => {
    seed("2026-06-12", ["今日は良い天気です。", "最悪だ。つらい。", "コードを書いた。"]);
    analyzeAll(db)._unsafeUnwrap();

    const daily = dailySentiment(db)._unsafeUnwrap();
    expect(daily).toHaveLength(1);
    const day = daily[0];
    expect(day?.date).toBe("2026-06-12");
    expect(day?.chunks).toBe(3);
    expect(day?.scored).toBe(3);
    expect(day?.positive).toBe(1);
    expect(day?.negative).toBe(1);
    expect(day?.neutral).toBe(1);
    expect(day?.average).toBeCloseTo(0, 5);
  });

  test("チャンクが消えたら使われないタグも消える", () => {
    seed("2026-06-12", ["特殊な合言葉ペンギン会議。"]);
    analyzeAll(db)._unsafeUnwrap();
    seed("2026-06-12", ["別の内容になった。"]);
    analyzeAll(db)._unsafeUnwrap();
    const tags = listTagsByChunk(db)._unsafeUnwrap();
    for (const names of tags.values()) {
      expect(names).not.toContain("ペンギン");
    }
  });
});
