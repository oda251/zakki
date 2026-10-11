import { beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import { MAX_PART_BYTES, PERMANENT_MAX_BYTES } from "@zakki/core/file/upload.ts";
import { memoryFileStore } from "@zakki/web/server/files/test-store.ts";
import { objectKeyFor } from "@zakki/web/server/files/store.ts";
import { createApp } from "@zakki/web/server/app.ts";

/**
 * issue #157: R2 への multipart アップロード中継。サーバはバイト列を右から左へ
 * 渡すだけで、暗号化するかどうかもクライアントが決める（#28 の不変条件は保つ）。
 */
let db: Db;
let store: ReturnType<typeof memoryFileStore>;
let app: Hono;

const FILE_ID = "1758000000000123";

beforeEach(async () => {
  db = await createDb(":memory:");
  store = memoryFileStore();
  app = createApp({ db, files: store });
});

/** 中継先アカウントを固定して組む（マルチユーザ構成の相当物） */
function appForAccount(accountId: string | null): Hono {
  return createApp({
    db,
    files: store,
    resolveUser: () => Promise.resolve(accountId === null ? null : { db, accountId }),
  });
}

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

const begin = (
  target: Hono,
  fileId = FILE_ID,
  retention: "permanent" | "1d" | "7d" | "30d" = "7d",
  size = 20,
) =>
  target.request(`/api/files/${fileId}/multipart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ retention, size }),
  });

const putPart = (
  target: Hono,
  uploadId: string,
  n: number,
  body: Uint8Array,
  fileId = FILE_ID,
  retention: "permanent" | "1d" | "7d" | "30d" = "7d",
) =>
  target.request(
    `/api/files/${fileId}/multipart/${uploadId}/parts/${n}?retention=${encodeURIComponent(retention)}`,
    {
      method: "PUT",
      body: Uint8Array.from(body),
    },
  );

const complete = (
  target: Hono,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
  fileId = FILE_ID,
  retention: "permanent" | "1d" | "7d" | "30d" = "7d",
) =>
  target.request(
    `/api/files/${fileId}/multipart/${uploadId}/complete?retention=${encodeURIComponent(retention)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    },
  );

const cancel = (
  target: Hono,
  uploadId: string,
  fileId = FILE_ID,
  retention: "permanent" | "1d" | "7d" | "30d" = "7d",
) =>
  target.request(
    `/api/files/${fileId}/multipart/${uploadId}?retention=${encodeURIComponent(retention)}`,
    { method: "DELETE" },
  );

const getFile = (
  target: Hono,
  fileId = FILE_ID,
  retention: "permanent" | "1d" | "7d" | "30d" = "7d",
) => target.request(`/api/files/${fileId}?retention=${encodeURIComponent(retention)}`);

const deleteFile = (
  target: Hono,
  fileId = FILE_ID,
  retention: "permanent" | "1d" | "7d" | "30d" = "7d",
) =>
  target.request(`/api/files/${fileId}?retention=${encodeURIComponent(retention)}`, {
    method: "DELETE",
  });

describe("認証", () => {
  test("D1: 中継先が解決できないリクエストは 401", async () => {
    const anon = appForAccount(null);
    expect((await begin(anon)).status).toBe(401);
    expect((await getFile(anon)).status).toBe(401);
    expect((await deleteFile(anon)).status).toBe(401);
  });
});

describe("multipart アップロード", () => {
  test("D2: 開始すると uploadId と partSize が返る", async () => {
    const started = await json<{ uploadId: string; partSize: number; retention: string }>(
      await begin(app),
    );
    expect(started.uploadId).not.toBe("");
    expect(started.partSize).toBeGreaterThan(0);
    expect(started.retention).toBe("7d");
  });

  test("D3: part を送ると etag が返り、R2 へ書かれる", async () => {
    const { uploadId } = await json<{ uploadId: string }>(await begin(app));
    const res = await json<{ etag: string }>(
      await putPart(app, uploadId, 1, new Uint8Array([1, 2, 3])),
    );
    expect(res.etag).not.toBe("");
  });

  test("D4: part が上限を超えると 413", async () => {
    const { uploadId } = await json<{ uploadId: string }>(await begin(app));
    const oversized = new Uint8Array(MAX_PART_BYTES + 1);
    expect((await putPart(app, uploadId, 1, oversized)).status).toBe(413);
    expect(store.aborted).toEqual([{ key: expect.any(String), uploadId }]);
  });

  test("D5: complete 後に GET が元のバイト列を返す", async () => {
    const { uploadId } = await json<{ uploadId: string }>(await begin(app));
    const a = await json<{ etag: string }>(await putPart(app, uploadId, 1, new Uint8Array([1, 2])));
    const b = await json<{ etag: string }>(await putPart(app, uploadId, 2, new Uint8Array([3])));
    await json<{ ok: boolean }>(
      await complete(app, uploadId, [
        { partNumber: 1, etag: a.etag },
        { partNumber: 2, etag: b.etag },
      ]),
    );

    const res = await getFile(app);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("D6: DELETE 後の GET は 404", async () => {
    const { uploadId } = await json<{ uploadId: string }>(await begin(app));
    const a = await json<{ etag: string }>(await putPart(app, uploadId, 1, new Uint8Array([7])));
    await complete(app, uploadId, [{ partNumber: 1, etag: a.etag }]);

    expect((await deleteFile(app)).status).toBe(200);
    expect((await getFile(app)).status).toBe(404);
  });

  test("存在しないファイルの GET は 404", async () => {
    expect((await getFile(app, "999")).status).toBe(404);
  });

  test("10 MiB 以上の permanent は 422 で R2 を作らない", async () => {
    const res = await begin(app, FILE_ID, "permanent", PERMANENT_MAX_BYTES);
    expect(res.status).toBe(422);
    expect(store.created).toHaveLength(0);
  });

  test("未知の retention は 400", async () => {
    const res = await app.request(`/api/files/${FILE_ID}/multipart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retention: "2d", size: 20 }),
    });
    expect(res.status).toBe(400);
    expect(store.created).toHaveLength(0);
  });

  test("complete の不正 body でも進行中 multipart を abort する", async () => {
    const { uploadId } = await json<{ uploadId: string }>(await begin(app));
    const res = await app.request(
      `/api/files/${FILE_ID}/multipart/${uploadId}/complete?retention=7d`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [] }),
      },
    );
    expect(res.status).toBe(400);
    expect(store.aborted).toEqual([{ key: expect.any(String), uploadId }]);
  });

  test("明示 cancel が multipart を abort する", async () => {
    const { uploadId } = await json<{ uploadId: string }>(await begin(app));
    expect((await cancel(app, uploadId)).status).toBe(200);
    expect(store.aborted).toEqual([{ key: expect.any(String), uploadId }]);
  });

  test("同じ fileId でも retention ごとに別オブジェクトになる", async () => {
    for (const [retention, byte] of [
      ["1d", 1],
      ["30d", 2],
    ] as const) {
      const { uploadId } = await json<{ uploadId: string }>(await begin(app, FILE_ID, retention));
      const part = await json<{ etag: string }>(
        await putPart(app, uploadId, 1, new Uint8Array([byte]), FILE_ID, retention),
      );
      await json<{ ok: boolean }>(
        await complete(app, uploadId, [{ partNumber: 1, etag: part.etag }], FILE_ID, retention),
      );
    }

    expect(store.objects.get(objectKeyFor("local", FILE_ID, "1d"))).toEqual(new Uint8Array([1]));
    expect(store.objects.get(objectKeyFor("local", FILE_ID, "30d"))).toEqual(new Uint8Array([2]));
    expect((await getFile(app, FILE_ID, "7d")).status).toBe(404);
  });
});

describe("D7: オブジェクトキーのアカウント分離", () => {
  test("同じ fileId でもアカウントが違えば別オブジェクトになる", async () => {
    const alice = appForAccount("acc-alice");
    const bob = appForAccount("acc-bob");

    const a = await json<{ uploadId: string }>(await begin(alice));
    const ap = await json<{ etag: string }>(
      await putPart(alice, a.uploadId, 1, new Uint8Array([1])),
    );
    await complete(alice, a.uploadId, [{ partNumber: 1, etag: ap.etag }]);

    const b = await json<{ uploadId: string }>(await begin(bob));
    const bp = await json<{ etag: string }>(await putPart(bob, b.uploadId, 1, new Uint8Array([2])));
    await complete(bob, b.uploadId, [{ partNumber: 1, etag: bp.etag }]);

    expect(store.objects.get(objectKeyFor("acc-alice", FILE_ID, "7d"))).toEqual(
      new Uint8Array([1]),
    );
    expect(store.objects.get(objectKeyFor("acc-bob", FILE_ID, "7d"))).toEqual(new Uint8Array([2]));

    // bob は alice のオブジェクトを読めない（自分の名前空間しか触らない）
    expect(new Uint8Array(await (await getFile(bob)).arrayBuffer())).toEqual(new Uint8Array([2]));
  });
});

describe("D8: R2 binding が無い配備", () => {
  test("ファイル経路は 503 を返す（単一ユーザ self-host）", async () => {
    const noStore = createApp({ db });
    expect((await begin(noStore)).status).toBe(503);
    expect((await getFile(noStore)).status).toBe(503);
  });
});
