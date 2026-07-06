import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, isNotNull } from "drizzle-orm";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import type { Embedder } from "@zakki/core/embedding/types.ts";
import { createDb, type Db } from "@zakki/data/db/client.ts";
import { aadFixups, chunks, chunkUserTags } from "@zakki/data/db/schema.ts";
import { getOrCreateDateChunk, listChildren } from "@zakki/data/chunk/repository.ts";
import { seedDayChunks } from "@zakki/data/chunk/testing.ts";
import { loadVectors, syncChunkEmbeddings } from "@zakki/data/embedding/store.ts";
import { applyAadFixups, initCrypto } from "./init.ts";

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

const DATE = "2026-06-21";
const CONTENT = "へいわなひ。";

describe("既存平文データの暗号化移行", () => {
  test("暗号 OFF で書いた行を initCrypto がその場で暗号化し、以後復号できる", async () => {
    // 1) 暗号 OFF（getCrypto undefined）で平文を保存
    const { root } = await seedDayChunks(db, DATE, [CONTENT]);
    (await syncChunkEmbeddings(db, fakeEmbedder))._unsafeUnwrap();

    // 平文が at-rest にある前提を確認（本文チャンク = parent_id 非 NULL）
    const before = await db
      .select({ content: chunks.content })
      .from(chunks)
      .where(isNotNull(chunks.parentId));
    expect(before[0]?.content).toBe(CONTENT);

    // 2) 暗号を有効化 → 既存平文を in-place 暗号化
    await initCrypto(db, sodium.randombytes_buf(32));

    // 本文チャンクの at-rest は暗号文になっている
    const after = await db
      .select({ content: chunks.content })
      .from(chunks)
      .where(isNotNull(chunks.parentId));
    expect(after[0]?.content).not.toContain("へいわ");

    // 通常読み出しは平文へ復号される
    const loaded = (await listChildren(db, root.id))._unsafeUnwrap();
    expect(loaded[0]?.content).toBe(CONTENT);

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

describe("applyAadFixups（chunk ツリー移行 0010 の AAD 付替え）", () => {
  test("旧 AAD の暗号文を新 AAD へ付替え、予約行を消す", async () => {
    // 暗号 ON にし ctx を得る（空 DB なので migrate は no-op で fixup も消さない）
    const ctx = await initCrypto(db, sodium.randombytes_buf(32));

    // 移行 SQL が残す状態を再現する:
    // - chunks.content に旧 AAD "session.name" のままの暗号文を直接 INSERT
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const now = new Date().toISOString();
    const [chunkRow] = await db
      .insert(chunks)
      .values({
        parentId: root.id,
        position: 0,
        content: ctx.encString("むかしのセッション名", "session.name"),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (chunkRow === undefined) throw new Error("seed 不足");
    // - chunk_user_tags.name に旧 AAD "sessionTag.name" のままの暗号文を直接 INSERT
    const [tagRow] = await db
      .insert(chunkUserTags)
      .values({
        chunkId: chunkRow.id,
        name: ctx.encString("旧タグ", "sessionTag.name"),
        nameFingerprint: ctx.fingerprint("旧タグ"),
        createdAt: now,
      })
      .returning();
    if (tagRow === undefined) throw new Error("seed 不足");
    // - 付替え予約
    await db.insert(aadFixups).values([
      { kind: "chunk.content", rowId: chunkRow.id },
      { kind: "chunkUserTag.name", rowId: tagRow.id },
    ]);

    await applyAadFixups(db, ctx);

    // 予約行は消える（冪等・毎回呼べる）
    expect(await db.select().from(aadFixups)).toHaveLength(0);

    // content は新 AAD "chunk.content" で復号できる
    const [afterChunk] = await db
      .select({ content: chunks.content })
      .from(chunks)
      .where(eq(chunks.id, chunkRow.id));
    expect(afterChunk).toBeDefined();
    if (afterChunk === undefined) throw new Error("読み出し失敗");
    expect(ctx.decString(afterChunk.content, "chunk.content")).toBe("むかしのセッション名");

    // name は新 AAD "chunkUserTag.name" で復号できる
    const [afterTag] = await db
      .select({ name: chunkUserTags.name })
      .from(chunkUserTags)
      .where(eq(chunkUserTags.id, tagRow.id));
    expect(afterTag).toBeDefined();
    if (afterTag === undefined) throw new Error("読み出し失敗");
    expect(ctx.decString(afterTag.name, "chunkUserTag.name")).toBe("旧タグ");
  });

  test("予約が無ければ no-op（毎回呼んで冪等）", async () => {
    const ctx = await initCrypto(db, sodium.randombytes_buf(32));
    await applyAadFixups(db, ctx);
    expect(await db.select().from(aadFixups)).toHaveLength(0);
  });
});
