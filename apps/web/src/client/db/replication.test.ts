import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { replDocs } from "@zakki/data/db/schema.ts";
import type { Hono } from "hono";
import type { FieldCrypto } from "@zakki/web/client/db/crypto.ts";
import { makeFieldCrypto } from "@zakki/web/client/db/crypto.ts";
import type { ChunkDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { createZakkiDb } from "@zakki/web/client/db/database.ts";
import { testStorage } from "@zakki/web/client/db/test-db.ts";
import { startReplication } from "@zakki/web/client/db/replication.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { createApp } from "@zakki/web/server/app.ts";

/**
 * issue #43: replicateRxCollection の配線を、実サーバ app（Hono + :memory: libSQL）へ
 * fetch アダプタで接続して検証する（受け入れ基準 1〜3）。
 * ストレージは memory（IndexedDB 不要）。本番は Dexie を注入する（bootstrap.ts）。
 */
const storage = testStorage;

let serverDb: Db;
let app: Hono;
let fetchFn: FetchLike;
let fc: FieldCrypto;
let dbs: ZakkiDatabase[] = [];
let nameSeq = 0;

beforeEach(async () => {
  const s = await ready();
  fc = makeFieldCrypto(s.crypto_aead_xchacha20poly1305_ietf_keygen());
  serverDb = await createDb(":memory:");
  app = createApp({ db: serverDb, engine: identityEngine });
  fetchFn = async (input, init) => app.request(input, init);
});

async function open(): Promise<ZakkiDatabase> {
  nameSeq += 1;
  const db = await createZakkiDb(storage(), `zakkitest${nameSeq}`);
  dbs.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(dbs.map((db) => db.remove()));
  dbs = [];
});

/** 1 回きり（live: false）の同期を全コレクションで実行する */
async function sync(db: ZakkiDatabase): Promise<void> {
  const states = startReplication(db, fc, { fetchFn, live: false });
  await Promise.all(Object.values(states).map((s) => s.awaitInSync()));
  await Promise.all(Object.values(states).map((s) => s.cancel()));
}

const chunk = (over: Partial<ChunkDoc> & { id: string }): ChunkDoc => ({
  parentId: "0",
  position: 0,
  content: "秘密の本文",
  date: null,
  polarity: null,
  updatedAt: "2026-07-07T00:00:01.000Z",
  ...over,
});

async function serverData(): Promise<string[]> {
  const rows = await serverDb.select().from(replDocs);
  return rows.map((r) => r.data);
}

describe("client replication (issue #43)", () => {
  test("D1+D3: 2 つの RxDB インスタンスが endpoint 経由で同期し、平文が一致する", async () => {
    const a = await open();
    const b = await open();
    await a.chunks.insert(chunk({ id: "1", content: "今日の記録" }));
    await a.tags.insert({ id: "10", name: "日記", updatedAt: "2026-07-07T00:00:02.000Z" });
    await a.chunkUserTags.insert({
      id: "20",
      chunkId: "1",
      name: "旅行",
      updatedAt: "2026-07-07T00:00:03.000Z",
    });

    await sync(a);
    await sync(b);

    expect((await b.chunks.findOne("1").exec())?.content).toBe("今日の記録");
    expect((await b.tags.findOne("10").exec())?.name).toBe("日記");
    expect((await b.chunkUserTags.findOne("20").exec())?.name).toBe("旅行");
  });

  test("D2: サーバ repl_docs.data は暗号文のみ（平文が出ない）＋ tag wire は fingerprint 付き", async () => {
    const a = await open();
    await a.chunks.insert(chunk({ id: "1", content: "秘密の本文" }));
    await a.tags.insert({ id: "10", name: "秘密タグ", updatedAt: "2026-07-07T00:00:02.000Z" });
    await a.chunkUserTags.insert({
      id: "20",
      chunkId: "1",
      name: "秘密ユーザタグ",
      updatedAt: "2026-07-07T00:00:03.000Z",
    });

    await sync(a);

    const data = await serverData();
    expect(data.length).toBe(3);
    for (const row of data) {
      expect(row).not.toContain("秘密");
    }
    const tagRow = data.find((d) => d.includes("nameFingerprint"));
    expect(tagRow).toContain(fc.fingerprint("秘密タグ"));
  });

  test("D4: 削除（tombstone）が他インスタンスへ伝播する", async () => {
    const a = await open();
    const b = await open();
    await a.chunks.insert(chunk({ id: "1" }));
    await sync(a);
    await sync(b);
    expect(await b.chunks.findOne("1").exec()).not.toBeNull();

    const doc = await a.chunks.findOne("1").exec();
    await doc?.incrementalPatch({ updatedAt: "2026-07-07T00:00:05.000Z" });
    await (await a.chunks.findOne("1").exec())?.remove();
    await sync(a);
    await sync(b);
    expect(await b.chunks.findOne("1").exec()).toBeNull();
  });

  test("D5: 衝突はサーバ（master）優先で解決する（DB-per-user の単純方針）", async () => {
    const a = await open();
    const b = await open();
    await a.chunks.insert(
      chunk({ id: "1", content: "サーバ側", updatedAt: "2026-07-07T00:00:09.000Z" }),
    );
    await sync(a);

    // b は未同期のまま同じ id を古い updatedAt で作る → pull 時に衝突 → master 採用
    await b.chunks.insert(
      chunk({ id: "1", content: "ローカル側", updatedAt: "2026-07-07T00:00:01.000Z" }),
    );
    await sync(b);

    expect((await b.chunks.findOne("1").exec())?.content).toBe("サーバ側");
  });

  test("D6: 日付チャンクの content は wire でも平文（Phase 2 のスキップが効く）", async () => {
    const a = await open();
    await a.chunks.insert(
      chunk({ id: "d1", parentId: null, date: "2026-07-07", content: "2026-07-07" }),
    );
    await sync(a);

    const data = await serverData();
    expect(data.some((d) => d.includes('"content":"2026-07-07"'))).toBe(true);
  });
});
