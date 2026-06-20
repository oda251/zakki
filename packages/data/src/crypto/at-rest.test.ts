import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { chunks, embeddings, entries } from "@zakki/data/db/schema.ts";
import { getEntryWithChunks, saveSnapshot } from "@zakki/data/entry/repository.ts";
import { loadVectors, syncChunkEmbeddings } from "@zakki/data/embedding/store.ts";
import { initCrypto } from "./init.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
});

const kek = () => sodium.randombytes_buf(32);

const fakeEmbedder: Embedder = {
  name: "fake",
  embed: (texts) => Promise.resolve(texts.map(() => Float32Array.from([0.5, -0.5]))),
};

const RAW = "kyouhaame";
const CONVERTED = "きょうはあめ。だるい。";
const CONTENT0 = "きょうはあめ。";
const CONTENT1 = "だるい。";

describe("暗号 ON の at-rest", () => {
  test("entries/chunks は平文で保存されず、読み出しでは復号される", async () => {
    await initCrypto(db, kek());

    (
      await saveSnapshot(db, {
        date: "2026-06-21",
        raw: RAW,
        converted: CONVERTED,
        chunks: [{ content: CONTENT0 }, { content: CONTENT1 }],
      })
    )._unsafeUnwrap();

    // schema 経由で列を直接読む（復号を経由しない at-rest の生値）
    const [erow] = await db
      .select({ raw: entries.raw, converted: entries.converted })
      .from(entries);
    expect(erow).toBeDefined();
    expect(erow?.raw).not.toBe(RAW);
    expect(erow?.raw).not.toContain(RAW);
    expect(erow?.converted).not.toContain("きょう");

    const crows = await db
      .select({ content: chunks.content })
      .from(chunks)
      .orderBy(asc(chunks.position));
    expect(crows.map((c) => c.content)).not.toContain(CONTENT0);
    for (const c of crows) {
      expect(c.content).not.toContain("あめ");
      expect(c.content).not.toContain("だるい");
    }

    // 通常の読み出し経路では平文へ復号される
    const loaded = (await getEntryWithChunks(db, "2026-06-21"))._unsafeUnwrap();
    expect(loaded?.entry.raw).toBe(RAW);
    expect(loaded?.entry.converted).toBe(CONVERTED);
    expect(loaded?.chunks.map((c) => c.content)).toEqual([CONTENT0, CONTENT1]);
  });

  test("embeddings.vector は生 float バイトで保存されず、loadVectors で復号される", async () => {
    await initCrypto(db, kek());
    (
      await saveSnapshot(db, {
        date: "2026-06-21",
        raw: RAW,
        converted: CONVERTED,
        chunks: [{ content: CONTENT0 }],
      })
    )._unsafeUnwrap();
    (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();

    const [row] = await db
      .select({ contentHash: embeddings.contentHash, vector: embeddings.vector })
      .from(embeddings);
    expect(row).toBeDefined();
    // 平文 2 要素ベクトルは 8 バイト。封筒は nonce(24)+ct(8+16tag) で 8 を超える。
    expect(row?.vector.byteLength).toBeGreaterThan(8);
    // content_hash は平文 Bun.hash でない（鍵付き）
    expect(row?.contentHash).not.toBe(Bun.hash(CONTENT0).toString(16));

    const vectors = (await loadVectors(db))._unsafeUnwrap();
    const v = [...vectors.values()][0];
    expect(v?.[0]).toBeCloseTo(0.5, 5);
    expect(v?.[1]).toBeCloseTo(-0.5, 5);

    // 再実行は差分なし（鍵付きハッシュで安定）
    const resync = (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
    expect(resync.embedded).toBe(0);
  });
});
