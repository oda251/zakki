import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { chunks, entries } from "@zakki/data/db/schema.ts";
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

const fakeEmbedder: Embedder = {
  name: "fake",
  embed: (texts) => Promise.resolve(texts.map(() => Float32Array.from([0.1, 0.9]))),
};

const RAW = "heiwa";
const CONVERTED = "へいわなひ。";
const CONTENT = "へいわなひ。";

describe("既存平文データの暗号化移行", () => {
  test("暗号 OFF で書いた行を initCrypto がその場で暗号化し、以後復号できる", async () => {
    // 1) 暗号 OFF（getCrypto undefined）で平文を保存
    (
      await saveSnapshot(db, {
        date: "2026-06-21",
        raw: RAW,
        converted: CONVERTED,
        chunks: [{ content: CONTENT }],
      })
    )._unsafeUnwrap();
    (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();

    // 平文が at-rest にある前提を確認
    const before = await db.select({ raw: entries.raw }).from(entries);
    expect(before[0]?.raw).toBe(RAW);

    // 2) 暗号を有効化 → 既存平文を in-place 暗号化
    await initCrypto(db, sodium.randombytes_buf(32));

    // at-rest は暗号文になっている
    const after = await db.select({ raw: entries.raw, converted: entries.converted }).from(entries);
    expect(after[0]?.raw).not.toBe(RAW);
    expect(after[0]?.raw).not.toContain(RAW);

    const crows = await db.select({ content: chunks.content }).from(chunks);
    expect(crows[0]?.content).not.toContain("へいわ");

    // 通常読み出しは平文へ復号される
    const loaded = (await getEntryWithChunks(db, "2026-06-21"))._unsafeUnwrap();
    expect(loaded?.entry.raw).toBe(RAW);
    expect(loaded?.entry.converted).toBe(CONVERTED);
    expect(loaded?.chunks[0]?.content).toBe(CONTENT);

    // ベクトルも暗号化され、復号で元に戻る
    const vectors = (await loadVectors(db))._unsafeUnwrap();
    const v = [...vectors.values()][0];
    expect(v?.[0]).toBeCloseTo(0.1, 5);
    expect(v?.[1]).toBeCloseTo(0.9, 5);

    // 移行直後は content_hash が温存されるため再 embed が 1 回走り、その後は安定
    (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
    expect((await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap().embedded).toBe(0);
  });
});
