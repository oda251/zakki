import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { chunks, files } from "@zakki/data/db/schema.ts";
import { deleteChunk, getOrCreateDateChunk, saveChildren } from "@zakki/data/chunk/repository.ts";
import { initCrypto } from "@zakki/data/crypto/init.ts";
import { createBlobChunk, getFile, insertFile, listFilesByChunk } from "./repository.ts";

let db: Db;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
});

const DATE = "2026-09-20";

/** 失敗を **await して** 検証する。bun の型では `.rejects.toThrow()` を await できない */
async function expectRejects(promise: Promise<unknown>): Promise<void> {
  let error: unknown = null;
  try {
    await promise;
  } catch (err: unknown) {
    error = err;
  }
  expect(error).not.toBeNull();
}

const input = (over: Partial<Parameters<typeof insertFile>[1]> = {}) => ({
  name: "写真",
  extension: "png",
  encryption: "none" as const,
  objectKey: "accounts/acc1/1001",
  retention: "7d" as const,
  size: 1234,
  partSize: 33_554_432,
  ...over,
});

describe("files テーブル", () => {
  test("insertFile が行を作り、getFile で読み戻せる", async () => {
    const created = (await insertFile(db, input()))._unsafeUnwrap();
    const loaded = (await getFile(db, created.id))._unsafeUnwrap();
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("写真");
    expect(loaded?.extension).toBe("png");
    expect(loaded?.encryption).toBe("none");
    expect(loaded?.objectKey).toBe("accounts/acc1/1001");
    expect(loaded?.retention).toBe("7d");
  });

  test("暗号 ON では name が平文で保存されず、読み出しで復号される", async () => {
    await initCrypto(db, sodium.randombytes_buf(32));
    const created = (await insertFile(db, input({ name: "秘密のメモ" })))._unsafeUnwrap();

    const [raw] = await db.select().from(files).where(eq(files.id, created.id));
    expect(raw?.name).not.toBe("秘密のメモ");
    // 拡張子は弁別に使うため平文のまま（docs/tmp/157-file-upload.md の決定）
    expect(raw?.extension).toBe("png");
    expect(raw?.retention).toBe("7d");

    expect((await getFile(db, created.id))._unsafeUnwrap()?.name).toBe("秘密のメモ");
  });
});

describe("blob チャンク", () => {
  test("kind='blob' で file_id を持つチャンクを作れる", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const file = (await insertFile(db, input()))._unsafeUnwrap();
    const chunk = (await createBlobChunk(db, root.id, file.id))._unsafeUnwrap();
    expect(chunk.kind).toBe("blob");
    expect(chunk.fileId).toBe(file.id);
  });

  test("kind='blob' なのに file_id が NULL の行は CHECK 制約で入らない", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    await expectRejects(
      db
        .insert(chunks)
        .values({
          parentId: root.id,
          position: 5,
          kind: "blob",
          fileId: null,
          content: "",
          createdAt: "2026-09-20T00:00:00.000Z",
          updatedAt: "2026-09-20T00:00:00.000Z",
        })
        .execute(),
    );
  });

  test("kind='text' なのに file_id を持つ行は CHECK 制約で入らない", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const file = (await insertFile(db, input()))._unsafeUnwrap();
    await expectRejects(
      db
        .insert(chunks)
        .values({
          parentId: root.id,
          position: 6,
          kind: "text",
          fileId: file.id,
          content: "",
          createdAt: "2026-09-20T00:00:00.000Z",
          updatedAt: "2026-09-20T00:00:00.000Z",
        })
        .execute(),
    );
  });

  test("既存のテキストチャンクは kind='text' になる", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const saved = (await saveChildren(db, root.id, [{ content: "あ。" }]))._unsafeUnwrap();
    expect(saved?.[0]?.kind).toBe("text");
    expect(saved?.[0]?.fileId).toBeNull();
    expect(root.kind).toBe("text");
  });

  test("listFilesByChunk が chunk id → file 行の対応を返す", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const file = (await insertFile(db, input()))._unsafeUnwrap();
    const chunk = (await createBlobChunk(db, root.id, file.id))._unsafeUnwrap();
    const map = (await listFilesByChunk(db))._unsafeUnwrap();
    expect(map.get(chunk.id)?.name).toBe("写真");
  });
});

describe("削除と R2 掃除", () => {
  test("deleteChunk は削除した部分木の objectKey を返し、files 行も消す", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const file = (await insertFile(db, input({ objectKey: "accounts/acc1/2002" })))._unsafeUnwrap();
    const chunk = (await createBlobChunk(db, root.id, file.id))._unsafeUnwrap();

    const keys = (await deleteChunk(db, chunk.id))._unsafeUnwrap();
    expect(keys).toEqual(["accounts/acc1/2002"]);
    expect((await getFile(db, file.id))._unsafeUnwrap()).toBeNull();
  });

  test("子孫の blob チャンクの objectKey も返す", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const container = (await saveChildren(db, root.id, [{ content: "箱" }]))._unsafeUnwrap()?.[0];
    if (container === undefined) throw new Error("container が作られていない");
    const file = (await insertFile(db, input({ objectKey: "accounts/acc1/3003" })))._unsafeUnwrap();
    await createBlobChunk(db, container.id, file.id);

    const keys = (await deleteChunk(db, container.id))._unsafeUnwrap();
    expect(keys).toEqual(["accounts/acc1/3003"]);
  });

  test("テキストチャンクだけの削除では objectKey が空", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const saved = (await saveChildren(db, root.id, [{ content: "あ。" }]))._unsafeUnwrap();
    const id = saved?.[0]?.id;
    if (id === undefined) throw new Error("chunk が作られていない");
    expect((await deleteChunk(db, id))._unsafeUnwrap()).toEqual([]);
  });
});

describe("テキスト草稿の投影は blob チャンクを消さない", () => {
  test("saveChildren の後も blob チャンクが残る", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    await saveChildren(db, root.id, [{ content: "一。" }, { content: "二。" }]);
    const file = (await insertFile(db, input()))._unsafeUnwrap();
    const blob = (await createBlobChunk(db, root.id, file.id))._unsafeUnwrap();

    // テキスト側だけを編集して保存し直す
    const saved = (await saveChildren(db, root.id, [{ content: "一改。" }]))._unsafeUnwrap();
    expect(saved).toHaveLength(1);

    const [survived] = await db.select().from(chunks).where(eq(chunks.id, blob.id));
    expect(survived?.kind).toBe("blob");
  });

  test("blob チャンクの position はテキストと衝突しない帯に置かれる", async () => {
    const root = (await getOrCreateDateChunk(db, DATE))._unsafeUnwrap();
    const file = (await insertFile(db, input()))._unsafeUnwrap();
    const first = (await createBlobChunk(db, root.id, file.id))._unsafeUnwrap();
    const file2 = (
      await insertFile(db, input({ objectKey: "accounts/acc1/4004" }))
    )._unsafeUnwrap();
    const second = (await createBlobChunk(db, root.id, file2.id))._unsafeUnwrap();

    expect(first.position).toBeGreaterThanOrEqual(1_000_000);
    expect(second.position).toBe(first.position + 1);
    // テキスト草稿は従来どおり 0 始まり
    const saved = (await saveChildren(db, root.id, [{ content: "一。" }]))._unsafeUnwrap();
    expect(saved?.[0]?.position).toBe(0);
  });
});
