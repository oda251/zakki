import { beforeEach, describe, expect, test } from "bun:test";
import { generateDek } from "@zakki/core/crypto/dek.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import { addKeyfileEnvelope, addPassphraseEnvelope } from "@zakki/data/crypto/envelopes.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import { openEnvelope } from "@zakki/web/client/db/unlock.ts";
import { createApp } from "@zakki/web/server/app.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";

/**
 * issue #43: GET /api/crypto/envelopes。封筒（wrapped DEK / salt / KDF パラメータ）は
 * KEK 無しには開けない公開可能情報で、サーバは平文 DEK を一切返さない（#28）。
 * keyfile 封筒はサーバ端末ローカルの KEK 専用なのでクライアントへは返さない。
 */
let db: Db;
let app: Hono;

beforeEach(async () => {
  await ready();
  db = await createDb(":memory:");
  app = createApp({ db });
});

async function getEnvelopes(): Promise<{ envelopes: CryptoEnvelope[] }> {
  const res = await app.request("/api/crypto/envelopes");
  expect(res.status).toBe(200);
  return (await res.json()) as { envelopes: CryptoEnvelope[] };
}

describe("GET /api/crypto/envelopes", () => {
  test("B1: 封筒なし（暗号未プロビジョン）→ { envelopes: [] }", async () => {
    expect(await getEnvelopes()).toEqual({ envelopes: [] });
  });

  test("B2: passphrase 封筒を base64 で返し、keyfile 封筒は含まない", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "ひみつのパスフレーズ");
    await addKeyfileEnvelope(db, dek, generateDek());

    const { envelopes } = await getEnvelopes();
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    if (env === undefined) throw new Error("envelope が空");
    expect(env.kind).toBe("passphrase");
    expect(typeof env.wrappedDek).toBe("string");
    expect(typeof env.kdfSalt).toBe("string");
    expect(env.kdfOps).toBeGreaterThan(0);
    expect(env.kdfMem).toBeGreaterThan(0);
  });

  test("B3: 返った封筒はクライアント openEnvelope（正しいパスフレーズ）で元の DEK に戻る", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(db, dek, "ひみつのパスフレーズ");

    const { envelopes } = await getEnvelopes();
    const env = envelopes[0];
    if (env === undefined) throw new Error("envelope が空");
    expect(openEnvelope(env, "ひみつのパスフレーズ")).toEqual(dek);
    expect(() => openEnvelope(env, "まちがい")).toThrow();
  });
});
