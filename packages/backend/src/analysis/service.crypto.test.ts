import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { initCrypto } from "@zakki/data/crypto/init.ts";
import { attachCrypto, getCrypto } from "@zakki/data/db/crypto-context.ts";
import { chunkTags, links, tags as tagsTable } from "@zakki/data/db/schema.ts";
import { listLinksByChunk, listTagsByChunk } from "@zakki/data/entry/queries.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { analyzeAll, analyzeChanged } from "./service.ts";

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

describe("analyzeChanged（暗号 ON）", () => {
  test("復号は変更チャンクに限定される", async () => {
    await seed("2026-06-12", ["かな漢字変換の辞書を調べた。", "散歩して天気の話をした。"]);
    await seed("2026-06-13", ["変換エンジンの辞書を組み込んだ。"]);
    (await analyzeChanged(db))._unsafeUnwrap(); // 初回は全量

    await seed("2026-06-13", ["変換エンジンの辞書を差し替えた。"]);

    // 復号呼び出しを数えるラッパを差し込む（保存後・解析前）
    const base = getCrypto(db);
    if (base === undefined) throw new Error("crypto 未初期化");
    let decrypted = 0;
    attachCrypto(db, {
      ...base,
      decString: (b64, label) => {
        if (label === "chunk.content") decrypted += 1;
        return base.decString(b64, label);
      },
    });
    const summary = (await analyzeChanged(db))._unsafeUnwrap();
    attachCrypto(db, base);

    // 再保存された 2026-06-13 の 1 チャンクだけ復号される（暗号 ON は再保存で
    // 暗号文が変わるため復号して内容比較する）。2026-06-12 の 2 チャンクは対象外
    expect(decrypted).toBe(1);
    expect(summary.taggedChunks).toBe(1);
  });

  test("増分適用後に analyzeAll を流しても状態が変わらない", async () => {
    await seed("2026-06-12", ["かな漢字変換の辞書を調べた。", "変換エンジンの辞書を組み込んだ。"]);
    (await analyzeChanged(db))._unsafeUnwrap();
    await seed("2026-06-13", ["辞書の学習データを整備した。"]);
    (await analyzeChanged(db))._unsafeUnwrap();

    const readState = async () => ({
      tags: (await listTagsByChunk(db))._unsafeUnwrap(),
      links: (await listLinksByChunk(db))._unsafeUnwrap(),
      chunkTags: (await db.select().from(chunkTags)).toSorted(
        (a, b) => a.chunkId - b.chunkId || a.tagId - b.tagId,
      ),
      autoLinks: (await db.select().from(links)).toSorted(
        (a, b) => a.fromChunkId - b.fromChunkId || a.toChunkId - b.toChunkId,
      ),
    });
    const afterIncremental = await readState();
    (await analyzeAll(db))._unsafeUnwrap();
    expect(await readState()).toEqual(afterIncremental);
  });
});
