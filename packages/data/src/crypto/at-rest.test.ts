import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { asc, isNotNull, isNull } from "drizzle-orm";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { chunks, embeddings } from "@zakki/data/db/schema.ts";
import { listChildren } from "@zakki/data/chunk/repository.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
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

const DATE = "2026-06-21";
const CONTENT0 = "きょうはあめ。";
const CONTENT1 = "だるい。";

describe("暗号 ON の at-rest", () => {
  test("本文チャンクは平文で保存されず、読み出しでは復号される", async () => {
    await initCrypto(db, kek());

    const { root } = await seedDayChunks(db, DATE, [CONTENT0, CONTENT1]);

    // schema 経由で本文チャンク（parent_id 非 NULL）を直接読む（復号を経由しない生値）
    const crows = await db
      .select({ content: chunks.content })
      .from(chunks)
      .where(isNotNull(chunks.parentId))
      .orderBy(asc(chunks.position));
    expect(crows.map((c) => c.content)).not.toContain(CONTENT0);
    for (const c of crows) {
      expect(c.content).not.toContain("あめ");
      expect(c.content).not.toContain("だるい");
    }

    // 通常の読み出し経路では平文へ復号される
    const loaded = (await listChildren(db, root.id))._unsafeUnwrap();
    expect(loaded.map((c) => c.content)).toEqual([CONTENT0, CONTENT1]);
  });

  test("日付チャンクの content は暗号化されず date と同値の平文", async () => {
    await initCrypto(db, kek());
    await seedDayChunks(db, DATE, [CONTENT0]);

    const [dateRow] = await db
      .select({ content: chunks.content, date: chunks.date })
      .from(chunks)
      .where(isNull(chunks.parentId));
    expect(dateRow?.date).toBe(DATE);
    // date が平文である方針の帰結として content も平文のまま（復号もスキップされる）
    expect(dateRow?.content).toBe(DATE);
  });

  test("embeddings.vector は生 float バイトで保存されず、loadVectors で復号される", async () => {
    await initCrypto(db, kek());
    await seedDayChunks(db, DATE, [CONTENT0]);
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
