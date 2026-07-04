import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { initCrypto } from "@zakki/data/crypto/init.ts";
import { tags as tagsTable } from "@zakki/data/db/schema.ts";
import { listTagsByChunk } from "@zakki/data/entry/queries.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { analyzeAll } from "./service.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
  await initCrypto(db, sodium.randombytes_buf(32));
});

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

describe("analyzeAll（暗号 ON）", () => {
  test("タグ名は at-rest で暗号化され、読み出しでは復号される", async () => {
    await seed("2026-06-12", ["かな漢字変換の辞書を調べた。", "変換エンジンの辞書を組み込んだ。"]);
    (await analyzeAll(db))._unsafeUnwrap();

    // tags.name 列は平文を含まない（fingerprint で一意化）
    const rows = await db
      .select({ name: tagsTable.name, nameFingerprint: tagsTable.nameFingerprint })
      .from(tagsTable);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.name).not.toContain("辞書");
      expect(r.name).not.toContain("変換");
      expect(r.nameFingerprint).not.toContain("辞書");
    }

    // 読み出し経路は平文へ復号
    const tags = (await listTagsByChunk(db))._unsafeUnwrap();
    expect(tags.get(1)).toContain("辞書");
  });

  test("同じタグ名は fingerprint UNIQUE で 1 行に重複排除される", async () => {
    // 同じ名詞「辞書」を含む別チャンクを 2 回の解析でまたいでも 1 行
    await seed("2026-06-12", ["辞書の辞書の辞書。", "辞書を辞書で辞書。"]);
    (await analyzeAll(db))._unsafeUnwrap();
    (await analyzeAll(db))._unsafeUnwrap();

    const fingerprints = (
      await db.select({ nameFingerprint: tagsTable.nameFingerprint }).from(tagsTable)
    ).map((r) => r.nameFingerprint);
    // 行数 == distinct fingerprint 数（重複なし）
    expect(fingerprints.length).toBe(new Set(fingerprints).size);
    expect(fingerprints.length).toBeGreaterThan(0);
  });
});
