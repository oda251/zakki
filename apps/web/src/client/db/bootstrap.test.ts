import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateDek } from "@zakki/core/crypto/dek.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import { addPassphraseEnvelope } from "@zakki/data/crypto/envelopes.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import type { ClientDb } from "@zakki/web/client/db/bootstrap.ts";
import { bootstrapClientDb } from "@zakki/web/client/db/bootstrap.ts";
import { makeFieldCrypto } from "@zakki/web/client/db/crypto.ts";
import { testStorage } from "@zakki/web/client/db/test-db.ts";
import { chunkPush } from "@zakki/web/client/db/modifiers.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { createApp } from "@zakki/web/server/app.ts";

/**
 * issue #43: 起動シーケンス（受け入れ基準 3）。unlock（封筒 → パスフレーズ → DEK）から
 * replication ready までを、注入した memory storage / fetch / prompt で検証する。
 * 本番既定（Dexie / window.prompt / グローバル fetch）は main.tsx の合成点でのみ使う。
 */
const PASSPHRASE = "起動テスト用パスフレーズ";
let serverDb: Db;
let app: Hono;
let fetchFn: FetchLike;
let handles: ClientDb[] = [];
let nameSeq = 0;

beforeEach(async () => {
  await ready();
  serverDb = await createDb(":memory:");
  app = createApp({ db: serverDb });
  fetchFn = async (input, init) => app.request(input, init);
});

afterEach(async () => {
  await Promise.all(handles.map((h) => h.db.remove()));
  handles = [];
});

async function boot(promptFn: (attempt: number) => Promise<string | null>): Promise<ClientDb> {
  nameSeq += 1;
  const handle = await bootstrapClientDb({
    storage: testStorage(),
    dbName: `zakkiboot${nameSeq}`,
    fetchFn,
    promptFn,
    replicationOptions: { live: false },
  });
  handles.push(handle);
  return handle;
}

describe("bootstrapClientDb", () => {
  test("E1: 封筒あり + 正しいパスフレーズ → replication が動き、サーバの暗号文が平文で読める", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(serverDb, dek, PASSPHRASE);

    // サーバへ暗号文 wire を直接シード（別クライアントが push 済みの状態を再現）
    const fc = makeFieldCrypto(dek);
    const wire = chunkPush(fc, {
      id: "1",
      parentId: null,
      position: 0,
      content: "別デバイスからの記録",
      date: null,
      polarity: null,
      updatedAt: "2026-07-07T00:00:01.000Z",
      _deleted: false,
    });
    const res = await app.request("/api/replication/chunks/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: [{ assumedMasterState: null, newDocumentState: wire }] }),
    });
    expect(res.status).toBe(200);

    const handle = await boot(() => Promise.resolve(PASSPHRASE));
    expect(handle.replication).not.toBeNull();
    // bootstrap は初回同期を待たずに返る（オフラインで UI がブロックされないため, #44）。
    // 同期完了は replication states を await して確認する
    await Promise.all(
      Object.values(handle.replication ?? {}).map((state) => state.awaitInitialReplication()),
    );
    expect((await handle.db.chunks.findOne("1").exec())?.content).toBe("別デバイスからの記録");
  });

  test("E3: 封筒フェッチ失敗（オフライン相当）→ replication null で DB は local で使える", async () => {
    fetchFn = () => Promise.reject(new Error("network down"));
    const handle = await boot(() => Promise.resolve(PASSPHRASE));
    expect(handle.replication).toBeNull();
    await handle.db.chunks.insert({
      id: "offline",
      parentId: null,
      position: 0,
      content: "オフラインでも書ける",
      date: null,
      polarity: null,
      updatedAt: "2026-07-07T00:00:01.000Z",
    });
    expect((await handle.db.chunks.findOne("offline").exec())?.content).toBe(
      "オフラインでも書ける",
    );
  });

  test("E2: 封筒なし（暗号未プロビジョン）→ replication は null（平文を wire に出さない）", async () => {
    let asked = 0;
    const handle = await boot(() => {
      asked += 1;
      return Promise.resolve(PASSPHRASE);
    });
    expect(handle.replication).toBeNull();
    expect(asked).toBe(0);
  });

  test("E2: パスフレーズ入力キャンセル → replication は null（DB は使える）", async () => {
    await addPassphraseEnvelope(serverDb, generateDek(), PASSPHRASE);
    const handle = await boot(() => Promise.resolve(null));
    expect(handle.replication).toBeNull();
    await handle.db.chunks.insert({
      id: "local",
      parentId: null,
      position: 0,
      content: "ローカルのみ",
      date: null,
      polarity: null,
      updatedAt: "2026-07-07T00:00:01.000Z",
    });
    expect((await handle.db.chunks.findOne("local").exec())?.content).toBe("ローカルのみ");
  });
});
