import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { generateFek } from "@zakki/core/crypto/file-key.ts";
import { PERMANENT_MAX_BYTES, type FileRetention } from "@zakki/core/file/upload.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import type { ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { openTestDb } from "@zakki/web/client/db/test-db.ts";
import { getOrCreateDateChunkDoc, removeChunkTree } from "@zakki/web/client/db/writes.ts";
import { downloadFile, uploadFile } from "@zakki/web/client/files/upload.ts";
import { createApp } from "@zakki/web/server/app.ts";
import { memoryFileStore } from "@zakki/web/server/files/test-store.ts";
import { objectKeyFor } from "@zakki/web/server/files/store.ts";

/**
 * issue #157: クライアント側のアップロード。中継サーバ（Hono）と
 * インメモリ R2 を実体として通し、part 分割・暗号化・doc 作成までを縛る。
 */
let db: ZakkiDatabase;
let serverDb: Db;
let store: ReturnType<typeof memoryFileStore>;
let app: Hono;
let fetchFn: FetchLike;

const ACCOUNT = "acc-test";
const DATE = "2026-09-20";
/** part 分割を実際に起こすための小さな part サイズ */
const PART_SIZE = 8;

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await openTestDb(`upload-${Math.random().toString(36).slice(2)}`);
  serverDb = await createDb(":memory:");
  store = memoryFileStore();
  app = createApp({
    db: serverDb,
    files: store,
    partSize: PART_SIZE,
    resolveUser: () => Promise.resolve({ db: serverDb, accountId: ACCOUNT }),
  });
  fetchFn = async (input, init) => app.request(input, init);
});

afterEach(async () => {
  await db.remove();
});

const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 251);

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

async function upload(
  content: Uint8Array,
  fek: Uint8Array | null,
  name = "写真.png",
  retention: FileRetention = "7d",
) {
  const root = await getOrCreateDateChunkDoc(db, DATE);
  return uploadFile({
    db,
    parentId: root.id,
    file: new File([Uint8Array.from(content)], name),
    fek,
    retention,
    fetchFn,
  });
}

describe("uploadFile", () => {
  test("F1/F2: part を分割して送り、files doc と blob チャンク doc を作る", async () => {
    const content = bytes(20);
    const { file, chunk } = await upload(content, null);

    expect(file.extension).toBe("png");
    expect(file.name).toBe("写真");
    expect(file.encryption).toBe("none");
    expect(file.retention).toBe("7d");
    expect(file.size).toBe(20);
    expect(chunk.kind).toBe("blob");
    expect(chunk.fileId).toBe(file.id);
    expect(chunk.content).toBe("");

    // 分割された part が R2 上で 1 本に戻っている
    expect(store.objects.get(objectKeyFor(ACCOUNT, file.id, "7d"))).toEqual(content);

    // RxDB にも入っている
    expect(await db.files.findOne(file.id).exec()).not.toBeNull();
    expect(await db.chunks.findOne(chunk.id).exec()).not.toBeNull();
  });

  test("F3: 暗号化 ON では R2 上のバイト列が平文と一致しない", async () => {
    const content = bytes(20);
    const fek = generateFek();
    const { file } = await upload(content, fek);

    expect(file.encryption).toBe("password");
    const stored = store.objects.get(objectKeyFor(ACCOUNT, file.id, "7d"));
    expect(stored).not.toEqual(content);
    // part ごとに nonce+tag の 40 バイトが乗る
    expect(stored?.length).toBe(content.length + Math.ceil(20 / PART_SIZE) * 40);

    // 同じ FEK で復号すると元に戻る
    expect(await downloadFile({ file, fek, fetchFn })).toEqual(content);
  });

  test("平文アップロードはそのまま取り出せる", async () => {
    const content = bytes(20);
    const { file } = await upload(content, null);
    expect(await downloadFile({ file, fek: null, fetchFn })).toEqual(content);
  });

  test("9 GiB 超は送らずに失敗する", async () => {
    const root = await getOrCreateDateChunkDoc(db, DATE);
    const huge = { name: "big.bin", size: 9 * 1024 ** 3 + 1, slice: () => new Blob() };
    await expectRejects(
      uploadFile({ db, parentId: root.id, file: huge, fek: null, retention: "7d", fetchFn }),
    );
    expect(store.objects.size).toBe(0);
  });

  test("10 MiB 以上の permanent は通信前に失敗する", async () => {
    const root = await getOrCreateDateChunkDoc(db, DATE);
    const large = {
      name: "large.bin",
      size: PERMANENT_MAX_BYTES,
      slice: () => new Blob(),
    };
    let requests = 0;
    await expectRejects(
      uploadFile({
        db,
        parentId: root.id,
        file: large,
        fek: null,
        retention: "permanent",
        fetchFn: async () => {
          requests += 1;
          return new Response(null, { status: 500 });
        },
      }),
    );
    expect(requests).toBe(0);
    expect(store.created).toHaveLength(0);
  });

  test("begin は retention と size を送り、part 失敗時は multipart を cancel する", async () => {
    const root = await getOrCreateDateChunkDoc(db, DATE);
    const requests: { url: string; method: string; body: string | null }[] = [];
    const file = new File([new Uint8Array([1, 2, 3])], "a.bin");
    const failingFetch: FetchLike = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
      if (method === "PUT") return new Response(null, { status: 500 });
      return app.request(input, init);
    };

    await expectRejects(
      uploadFile({
        db,
        parentId: root.id,
        file,
        fek: null,
        retention: "30d",
        fetchFn: failingFetch,
      }),
    );

    expect(requests[0]?.body).toBe(JSON.stringify({ retention: "30d", size: 3 }));
    expect(requests.at(-1)?.method).toBe("DELETE");
    expect(requests.at(-1)?.url).toContain("/multipart/");
    expect(requests.at(-1)?.url).toContain("retention=30d");
  });

  test("TTL で R2 本体だけ消えても files doc と blob chunk は残す", async () => {
    const { file, chunk } = await upload(bytes(10), null, "expires.png", "1d");
    await store.delete("1d", objectKeyFor(ACCOUNT, file.id, "1d"));

    await expectRejects(downloadFile({ file, fek: null, fetchFn }));
    expect(await db.files.findOne(file.id).exec()).not.toBeNull();
    expect(await db.chunks.findOne(chunk.id).exec()).not.toBeNull();
  });
});

describe("F4: blob チャンクの削除", () => {
  test("R2 のオブジェクトも消える", async () => {
    const { file, chunk } = await upload(bytes(10), null);
    expect(store.objects.has(objectKeyFor(ACCOUNT, file.id, "7d"))).toBe(true);

    const deletes: string[] = [];
    await removeChunkTree(db, chunk.id, {
      fetchFn: async (input, init) => {
        if (init?.method === "DELETE") deletes.push(String(input));
        return fetchFn(input, init);
      },
    });

    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("retention=7d");
    expect(store.objects.has(objectKeyFor(ACCOUNT, file.id, "7d"))).toBe(false);
    expect(await db.files.findOne(file.id).exec()).toBeNull();
  });

  test("親ごと消すと子孫の blob も消える", async () => {
    const root = await getOrCreateDateChunkDoc(db, DATE);
    const { file } = await upload(bytes(10), null);
    await removeChunkTree(db, root.id, { fetchFn });
    expect(store.objects.has(objectKeyFor(ACCOUNT, file.id, "7d"))).toBe(false);
  });
});
