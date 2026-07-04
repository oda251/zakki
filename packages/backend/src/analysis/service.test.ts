import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { dailySentiment, listLinksByChunk, listTagsByChunk } from "@zakki/data/entry/queries.ts";
import { createSession, listSessions, setSessionTags } from "@zakki/data/session/repository.ts";
import { analyzeAll } from "./service.ts";

let db: Db;

async function seed(date: string, contents: string[]): Promise<void> {
  (
    await saveSnapshot(db, {
      date,
      raw: "",
      converted: contents.join(""),
      chunks: contents.map((content) => ({ content })),
    })
  )._unsafeUnwrap();
}

beforeEach(async () => {
  db = await createDb(":memory:");
});

describe("analyzeAll", () => {
  test("タグと関連リンクを永続化する", async () => {
    await seed("2026-06-12", [
      "かな漢字変換の辞書を調べた。",
      "変換エンジンの辞書を組み込んだ。",
      "散歩して天気の話をした。",
    ]);

    const summary = (await analyzeAll(db))._unsafeUnwrap();
    expect(summary.taggedChunks).toBe(3);

    const tags = (await listTagsByChunk(db))._unsafeUnwrap();
    expect(tags.size).toBe(3);
    expect(tags.get(1)).toContain("辞書");

    // 1↔2 は「変換」「辞書」を共有して関連、3 は孤立
    const links = (await listLinksByChunk(db))._unsafeUnwrap();
    expect(links.get(1)).toEqual([2]);
    expect(links.get(2)).toEqual([1]);
    expect(links.get(3)).toBeUndefined();
  });

  test("再実行で冪等（タグ・リンクが重複しない）", async () => {
    await seed("2026-06-12", ["変換辞書の話。", "変換辞書の続き。"]);
    (await analyzeAll(db))._unsafeUnwrap();
    const first = (await listLinksByChunk(db))._unsafeUnwrap();
    (await analyzeAll(db))._unsafeUnwrap();
    const second = (await listLinksByChunk(db))._unsafeUnwrap();
    expect(second).toEqual(first);
  });

  test("ネガポジ極性を永続化し、日ごとに集計できる", async () => {
    await seed("2026-06-12", ["今日は良い天気です。", "最悪だ。つらい。", "コードを書いた。"]);
    (await analyzeAll(db))._unsafeUnwrap();

    const daily = (await dailySentiment(db))._unsafeUnwrap();
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

  test("チャンクが消えたら使われないタグも消える", async () => {
    await seed("2026-06-12", ["特殊な合言葉ペンギン会議。"]);
    (await analyzeAll(db))._unsafeUnwrap();
    await seed("2026-06-12", ["別の内容になった。"]);
    (await analyzeAll(db))._unsafeUnwrap();
    const tags = (await listTagsByChunk(db))._unsafeUnwrap();
    for (const names of tags.values()) {
      expect(names).not.toContain("ペンギン");
    }
  });

  test("manual リンク（自動リンク機能で付与）は analyzeAll の auto 張り替え後も残る", async () => {
    await seed("2026-06-12", ["最初の話。", "全然関係ない別の話。"]);
    const { listChunksWithDate } = await import("@zakki/data/entry/queries.ts");
    const { addManualLink } = await import("@zakki/data/link/repository.ts");
    const chunks = (await listChunksWithDate(db))._unsafeUnwrap();
    const [a, b] = chunks.map((c) => c.id);
    if (a === undefined || b === undefined) throw new Error("seed 不足");

    (await addManualLink(db, a, b))._unsafeUnwrap();
    (await analyzeAll(db))._unsafeUnwrap();

    const links = (await listLinksByChunk(db))._unsafeUnwrap();
    expect(links.get(a)).toContain(b);
  });

  test("セッションタグ（ユーザ明示）は解析の全消し再挿入・孤立削除に干渉されない", async () => {
    const session = (await createSession(db, { name: "調査", date: "2026-06-12" }))._unsafeUnwrap();
    (await setSessionTags(db, session.id, ["web", "設計"]))._unsafeUnwrap();

    await seed("2026-06-12", ["変換辞書の話。"]);
    (await analyzeAll(db))._unsafeUnwrap();

    const [loaded] = (await listSessions(db))._unsafeUnwrap();
    expect(loaded?.tags).toEqual(["web", "設計"]);
  });
});
