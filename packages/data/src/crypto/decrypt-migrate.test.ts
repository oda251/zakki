import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { isNotNull } from "drizzle-orm";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import { chunks, cryptoMeta, keyEnvelopes, tags } from "@zakki/data/db/schema.ts";
import { listChildren } from "@zakki/data/chunk/repository.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import { assertCryptoReady } from "@zakki/data/crypto/guard.ts";
import { loadVectors, syncChunkEmbeddings } from "@zakki/data/embedding/store.ts";
import { applyAnalysisPlan } from "@zakki/data/analysis/apply.ts";
import { initCrypto, migrateEncryptedToPlaintext } from "./init.ts";

/**
 * 暗号 → 平文の移行（issue #133）。
 *
 * 暗号は opt-in で既定 OFF に戻したので、`migratePlaintextToEncrypted` の逆が要る。
 * 「戻せる」ことの検証: 暗号 ON で書いた DB が、移行後に**暗号 OFF の DB と
 * 見分けがつかない状態**（at-rest が平文・封筒なし・fingerprint と content_hash が
 * OFF 側の規約）になること。
 */

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

const DATE = "2026-08-21";
const CONTENT = "へいわなひ。";
const TAG = "にっき";

/** 暗号 ON の DB を作り、本文・タグ・埋め込みを 1 件ずつ持たせる */
async function seedEncrypted(): Promise<{ rootId: number }> {
  const { root } = await seedDayChunks(db, DATE, [CONTENT]);
  const ctx = await initCrypto(db, sodium.randombytes_buf(32));
  expect(getCrypto(db)).toBe(ctx);

  const children = (await listChildren(db, root.id))._unsafeUnwrap();
  const chunkId = children[0]?.id ?? -1;
  await applyAnalysisPlan(
    db,
    {
      tagNames: new Set([TAG]),
      tagRewrites: [{ chunkId, tags: [{ name: TAG, score: 1 }] }],
      relinkChunkIds: [],
      insertLinks: [],
      polarityWrites: [],
    },
    new Date().toISOString(),
  );
  (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();
  return { rootId: root.id };
}

describe("migrateEncryptedToPlaintext", () => {
  test("本文・タグ・ベクトルが平文へ戻り、通常の読み出しが一致する", async () => {
    const { rootId } = await seedEncrypted();

    const encrypted = await db
      .select({ content: chunks.content })
      .from(chunks)
      .where(isNotNull(chunks.parentId));
    expect(encrypted[0]?.content).not.toContain("へいわ");

    const ctx = getCrypto(db);
    if (ctx === undefined) throw new Error("暗号 ON のはず");
    await migrateEncryptedToPlaintext(db, ctx);

    // at-rest が平文になっている
    const after = await db
      .select({ content: chunks.content })
      .from(chunks)
      .where(isNotNull(chunks.parentId));
    expect(after[0]?.content).toBe(CONTENT);

    // 通常の読み出し（暗号 OFF 経路）でも同じ値が読める
    const loaded = (await listChildren(db, rootId))._unsafeUnwrap();
    expect(loaded[0]?.content).toBe(CONTENT);

    // タグは平文名 + fingerprint = 平文名（暗号 OFF の書き込み規約と同じ）
    const tagRows = await db.select().from(tags);
    expect(tagRows[0]?.name).toBe(TAG);
    expect(tagRows[0]?.nameFingerprint).toBe(TAG);

    // ベクトルも平文 BLOB として読める
    const vectors = (await loadVectors(db))._unsafeUnwrap();
    const v = [...vectors.values()][0];
    expect(v?.[0]).toBeCloseTo(0.1, 5);
    expect(v?.[1]).toBeCloseTo(0.9, 5);
  });

  test("封筒とメタを消し、コンテキストを外す（以後は暗号 OFF の DB と同じ）", async () => {
    await seedEncrypted();
    const ctx = getCrypto(db);
    if (ctx === undefined) throw new Error("暗号 ON のはず");

    await migrateEncryptedToPlaintext(db, ctx);

    expect(await db.select().from(keyEnvelopes)).toEqual([]);
    expect(await db.select().from(cryptoMeta)).toEqual([]);
    // 外さないと、以後の書き込みが平文 DB へ暗号文を混ぜる
    expect(getCrypto(db)).toBeUndefined();
    // 封筒が無くなったのでサイレント平文読みガードも通る
    await assertCryptoReady(db);
  });

  test("content_hash が平文方式に揃い、再 embed が 1 回で収束する", async () => {
    await seedEncrypted();
    const ctx = getCrypto(db);
    if (ctx === undefined) throw new Error("暗号 ON のはず");

    await migrateEncryptedToPlaintext(db, ctx);

    // 平文方式のハッシュへ張り替えてあるので、差分検知は即座に「変化なし」になる
    expect((await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap().embedded).toBe(0);
  });

  test("暗号 ON → OFF → ON と往復しても内容が保たれる", async () => {
    const { rootId } = await seedEncrypted();
    const ctx = getCrypto(db);
    if (ctx === undefined) throw new Error("暗号 ON のはず");

    await migrateEncryptedToPlaintext(db, ctx);
    // 別の KEK で改めて暗号 ON（封筒は作り直し。DEK も新しくなる）
    await initCrypto(db, sodium.randombytes_buf(32));

    const loaded = (await listChildren(db, rootId))._unsafeUnwrap();
    expect(loaded[0]?.content).toBe(CONTENT);
    const reEncrypted = await db
      .select({ content: chunks.content })
      .from(chunks)
      .where(isNotNull(chunks.parentId));
    expect(reEncrypted[0]?.content).not.toContain("へいわ");
  });
});
