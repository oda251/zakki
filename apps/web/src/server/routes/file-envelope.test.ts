import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateSalt } from "@zakki/core/crypto/kdf.ts";
import { ready, sodium } from "@zakki/core/crypto/sodium.ts";
import { toBase64 } from "@zakki/core/crypto/wire.ts";
import { generateFek, unwrapFek, wrapFek } from "@zakki/core/crypto/file-key.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import { createApp } from "@zakki/web/server/app.ts";
import type { FileEnvelope } from "@zakki/web/shared/api-schemas.ts";

/**
 * issue #157: ファイル暗号鍵（FEK）の封筒配布。チャンクの DEK 封筒
 * （/api/crypto/envelopes）とは別の鍵・別のテーブルで、サーバは開けない。
 */
let db: Db;
let app: Hono;

const params = { opsLimit: 1, memLimit: 8192 * 1024 };

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
  app = createApp({ db });
});

function envelopeBody(password: string, salt: Uint8Array, fek: Uint8Array) {
  return {
    wrappedFek: toBase64(wrapFek(fek, password, salt, params)),
    kdfSalt: toBase64(salt),
    kdfOps: params.opsLimit,
    kdfMem: params.memLimit,
  };
}

const post = (body: unknown) =>
  app.request("/api/crypto/file-envelope", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (body: unknown) =>
  app.request("/api/crypto/file-envelope", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /api/crypto/file-envelope", () => {
  test("E1: 未設定なら envelope は null", async () => {
    const res = await app.request("/api/crypto/file-envelope");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ envelope: null });
  });

  test("E2: POST で保存した封筒が返り、パスワードで FEK を取り出せる", async () => {
    const fek = generateFek();
    const salt = generateSalt();
    expect((await post(envelopeBody("ひみつ", salt, fek))).status).toBe(200);

    const res = await app.request("/api/crypto/file-envelope");
    const { envelope } = (await res.json()) as { envelope: FileEnvelope | null };
    if (envelope === null) throw new Error("封筒が返っていない");
    expect(
      unwrapFek(
        sodium.from_base64(envelope.wrappedFek, sodium.base64_variants.ORIGINAL),
        "ひみつ",
        sodium.from_base64(envelope.kdfSalt, sodium.base64_variants.ORIGINAL),
        { opsLimit: envelope.kdfOps, memLimit: envelope.kdfMem },
      ),
    ).toEqual(fek);
  });

  test("E2: POST は初回だけ保存し、2 回目は 409", async () => {
    const first = envelopeBody("ふるい", generateSalt(), generateFek());
    expect((await post(first)).status).toBe(200);
    expect((await post(first)).status).toBe(409);
  });

  test("E2: PUT はパスワード変更専用で、封筒を同じ FEK で差し替える", async () => {
    const fek = generateFek();
    const first = generateSalt();
    const second = generateSalt();
    expect((await put(envelopeBody("ふるい", first, fek))).status).toBe(409);
    await post(envelopeBody("ふるい", first, fek));
    expect((await put(envelopeBody("あたらしい", second, fek))).status).toBe(200);

    const { envelope } = (await (await app.request("/api/crypto/file-envelope")).json()) as {
      envelope: FileEnvelope | null;
    };
    if (envelope === null) throw new Error("封筒が返っていない");
    expect(
      unwrapFek(
        sodium.from_base64(envelope.wrappedFek, sodium.base64_variants.ORIGINAL),
        "あたらしい",
        sodium.from_base64(envelope.kdfSalt, sodium.base64_variants.ORIGINAL),
        { opsLimit: envelope.kdfOps, memLimit: envelope.kdfMem },
      ),
    ).toEqual(fek);
  });

  test("E3: 封筒の長さが合わなければ 400（開けない封筒を保存させない）", async () => {
    const salt = generateSalt();
    const body = envelopeBody("ひみつ", salt, generateFek());
    expect((await put({ ...body, wrappedFek: toBase64(new Uint8Array(8)) })).status).toBe(400);
  });

  test("E4: 中継先が解決できないリクエストは 401", async () => {
    const anon = createApp({ db, resolveUser: () => Promise.resolve(null) });
    const body = envelopeBody("ひみつ", generateSalt(), generateFek());
    expect((await anon.request("/api/crypto/file-envelope")).status).toBe(401);
    expect(
      (
        await anon.request("/api/crypto/file-envelope", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await anon.request("/api/crypto/file-envelope", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
  });
});
