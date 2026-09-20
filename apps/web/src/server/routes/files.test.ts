import { beforeEach, describe, expect, test } from "bun:test";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import { MAX_PART_BYTES } from "@zakki/core/file/upload.ts";
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

const begin = (target: Hono, fileId = FILE_ID) =>
  target.request(`/api/files/${fileId}/multipart`, { method: "POST" });

const putPart = (target: Hono, uploadId: string, n: number, body: Uint8Array, fileId = FILE_ID) =>
  target.request(`/api/files/${fileId}/multipart/${uploadId}/parts/${n}`, {
    method: "PUT",
    body: Uint8Array.from(body),
  });

const complete = (
  target: Hono,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
  fileId = FILE_ID,
) =>
  target.request(`/api/files/${fileId}/multipart/${uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts }),
  });

describe("認証", () => {
  test("D1: 中継先が解決できないリクエストは 401", async () => {
    const anon = appForAccount(null);
    expect((await begin(anon)).status).toBe(401);
    expect((await anon.request(`/api/files/${FILE_ID}`)).status).toBe(401);
    expect((await anon.request(`/api/files/${FILE_ID}`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("multipart アップロード", () => {
  test("D2: 開始すると uploadId と partSize が返る", async () => {
    const started = await json<{ uploadId: string; partSize: number }>(await begin(app));
    expect(started.uploadId).not.toBe("");
    expect(started.partSize).toBeGreaterThan(0);
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

    const res = await app.request(`/api/files/${FILE_ID}`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("D6: DELETE 後の GET は 404", async () => {
    const { uploadId } = await json<{ uploadId: string }>(await begin(app));
    const a = await json<{ etag: string }>(await putPart(app, uploadId, 1, new Uint8Array([7])));
    await complete(app, uploadId, [{ partNumber: 1, etag: a.etag }]);

    expect((await app.request(`/api/files/${FILE_ID}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/api/files/${FILE_ID}`)).status).toBe(404);
  });

  test("存在しないファイルの GET は 404", async () => {
    expect((await app.request("/api/files/999")).status).toBe(404);
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

    expect(store.objects.get(objectKeyFor("acc-alice", FILE_ID))).toEqual(new Uint8Array([1]));
    expect(store.objects.get(objectKeyFor("acc-bob", FILE_ID))).toEqual(new Uint8Array([2]));

    // bob は alice のオブジェクトを読めない（自分の名前空間しか触らない）
    expect(
      new Uint8Array(await (await bob.request(`/api/files/${FILE_ID}`)).arrayBuffer()),
    ).toEqual(new Uint8Array([2]));
  });
});

describe("D8: R2 binding が無い配備", () => {
  test("ファイル経路は 503 を返す（単一ユーザ self-host）", async () => {
    const noStore = createApp({ db });
    expect((await begin(noStore)).status).toBe(503);
    expect((await noStore.request(`/api/files/${FILE_ID}`)).status).toBe(503);
  });
});
