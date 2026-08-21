import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { copyJournal, findExistingRows, verifyCopy } from "@zakki/data/db/copy.ts";
import { chunks, keyEnvelopes } from "@zakki/data/db/schema.ts";
import { listChildren } from "@zakki/data/chunk/repository.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import { addPassphraseEnvelope } from "@zakki/data/crypto/envelopes.ts";
import { applyAnalysisPlan } from "@zakki/data/analysis/apply.ts";
import { loadVectors, syncChunkEmbeddings } from "@zakki/data/embedding/store.ts";

/**
 * ジャーナル DB の移送（issue #136）。
 *
 * 受け入れ条件は「per-user DB に全データが揃い、TUI / Web から読める」。
 * ここでは **写した先が読める**ことと、**照合が実際に差を検出する**ことを縛る
 * （照合が常に OK を返すなら、移行の確認として意味が無い）。
 */

const DATE = "2026-08-21";
const CONTENT = "うつしたあとも よめる。";
const TAG = "にっき";

const fakeEmbedder: Embedder = {
  name: "fake",
  embed: (texts) => Promise.resolve(texts.map(() => Float32Array.from([0.25, 0.75]))),
};

let source: Db;
let target: Db;

beforeEach(async () => {
  await ready();
  source = await createDb(":memory:");
  target = await createDb(":memory:");
});

/** 本文・タグ・埋め込み・封筒（blob 列）を一通り持つ DB を作る */
async function seed(db: Db): Promise<number> {
  const { root } = await seedDayChunks(db, DATE, [CONTENT]);
  const children = (await listChildren(db, root.id))._unsafeUnwrap();
  const chunkId = children[0]?.id ?? -1;
  await applyAnalysisPlan(
    db,
    {
      tagNames: new Set([TAG]),
      tagRewrites: [{ chunkId, tags: [{ name: TAG, score: 1 }] }],
      relinkChunkIds: [],
      insertLinks: [],
      polarityWrites: [{ chunkId, polarity: 0.5, bump: false }],
    },
    new Date().toISOString(),
  );
  (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
  // blob 列（wrapped_dek / kdf_salt）を持つ行も運べることを見るため封筒を 1 本入れる
  await addPassphraseEnvelope(db, sodium.randombytes_buf(32), "移送テスト用パスフレーズ");
  return root.id;
}

describe("copyJournal", () => {
  test("写した先が通常の読み出しで同じ内容を返す", async () => {
    const rootId = await seed(source);

    await copyJournal(target, source);

    const loaded = (await listChildren(target, rootId))._unsafeUnwrap();
    expect(loaded[0]?.content).toBe(CONTENT);
    const vectors = (await loadVectors(target))._unsafeUnwrap();
    expect([...vectors.values()][0]?.[0]).toBeCloseTo(0.25, 5);
  });

  test("blob 列（封筒）もバイト単位で同じものが入る", async () => {
    await seed(source);

    await copyJournal(target, source);

    const [before] = await source.select().from(keyEnvelopes);
    const [after] = await target.select().from(keyEnvelopes);
    expect(after?.kind).toEqual(before?.kind);
    expect([...(after?.wrappedDek ?? [])]).toEqual([...(before?.wrappedDek ?? [])]);
  });

  test("照合はすべての表で一致する", async () => {
    await seed(source);

    await copyJournal(target, source);

    const comparisons = await verifyCopy(target, source);
    expect(comparisons.every((c) => c.matches)).toBe(true);
    // 空の表も含めて全部見ている（見落としが無いことの確認）
    expect(comparisons.map((c) => c.name)).toContain("repl_docs");
  });
});

describe("verifyCopy", () => {
  test("行数が同じでも内容が違えば一致しない", async () => {
    const rootId = await seed(source);
    await copyJournal(target, source);

    // 1 行だけ書き換える（行数は変わらない）
    const children = (await listChildren(target, rootId))._unsafeUnwrap();
    await target
      .update(chunks)
      .set({ content: "すりかえた" })
      .where(eq(chunks.id, children[0]?.id ?? -1));

    const comparisons = await verifyCopy(target, source);
    const chunksResult = comparisons.find((c) => c.name === "chunks");
    expect(chunksResult?.sourceRows).toBe(chunksResult?.targetRows ?? -1);
    expect(chunksResult?.matches).toBe(false);
  });
});

describe("findExistingRows", () => {
  test("空の DB では何も返さない", async () => {
    expect(await findExistingRows(target)).toEqual([]);
  });

  test("既に行がある表を報告する（移行を中止する根拠）", async () => {
    await seed(target);

    const existing = await findExistingRows(target);

    expect(existing.map((e) => e.name)).toContain("chunks");
  });
});
