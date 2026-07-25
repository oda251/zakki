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
import type { CredentialsApi } from "@zakki/web/client/db/passkey.ts";
import { fakeAuthenticator } from "@zakki/web/client/db/test-passkey.ts";
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

async function boot(
  promptFn: (attempt: number) => Promise<string | null>,
  credentialsApi: CredentialsApi | null = null,
): Promise<ClientDb> {
  nameSeq += 1;
  const handle = await bootstrapClientDb({
    storage: testStorage(),
    dbName: `zakkiboot${nameSeq}`,
    fetchFn,
    promptFn,
    // 既定（browserCredentials）は jsdom 無しの bun では常に null。明示注入で分岐を固定する
    credentialsApi,
    replicationOptions: { live: false },
  });
  handles.push(handle);
  return handle;
}

/** サーバへ暗号文 wire を直接シードする（別デバイスが push 済みの状態） */
async function seedEncryptedChunk(dek: Uint8Array, id: string, content: string): Promise<void> {
  const wire = chunkPush(makeFieldCrypto(dek), {
    id,
    parentId: null,
    position: 0,
    content,
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
}

describe("bootstrapClientDb", () => {
  test("E1: 封筒あり + 正しいパスフレーズ → replication が動き、サーバの暗号文が平文で読める", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(serverDb, dek, PASSPHRASE);

    // サーバへ暗号文 wire を直接シード（別クライアントが push 済みの状態を再現）
    await seedEncryptedChunk(dek, "1", "別デバイスからの記録");

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

/**
 * issue #104: passkey（WebAuthn PRF）でのアンロック統合。認証器は fake を注入し
 * （test-passkey.ts）、封筒の登録・配布・復号はすべて本物の経路を通す。
 */
describe("bootstrapClientDb + passkey (#104)", () => {
  test("P1: 登録 → 再読込相当 → 無言アンロック → サーバの暗号文が平文で読める", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(serverDb, dek, PASSPHRASE);
    await seedEncryptedChunk(dek, "p1", "パスキーで読めた記録");
    const api = fakeAuthenticator();

    // 1 回目: パスフレーズでアンロックし、その状態からパスキーを登録する
    const first = await boot(() => Promise.resolve(PASSPHRASE), api);
    expect(first.passkey.available).toBe(true);
    expect(first.passkey.enrolled).toBe(false);
    if (first.passkey.enroll === null) throw new Error("アンロック済みなら登録できるはず");
    await first.passkey.enroll();

    // 2 回目（再読込相当）: prompt は一度も呼ばれず、passkey だけでアンロックできる
    let asked = 0;
    const second = await boot(() => {
      asked += 1;
      return Promise.resolve(PASSPHRASE);
    }, api);
    expect(asked).toBe(0);
    expect(second.passkey.enrolled).toBe(true);
    expect(second.replication).not.toBeNull();
    await Promise.all(
      Object.values(second.replication ?? {}).map((state) => state.awaitInitialReplication()),
    );
    expect((await second.db.chunks.findOne("p1").exec())?.content).toBe("パスキーで読めた記録");
  });

  test("P2: passkey 封筒あり + PRF 失敗 → パスフレーズへフォールバックして同期できる", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(serverDb, dek, PASSPHRASE);
    await seedEncryptedChunk(dek, "p2", "フォールバックで読めた記録");
    const api = fakeAuthenticator();
    const enrolled = await boot(() => Promise.resolve(PASSPHRASE), api);
    await enrolled.passkey.enroll?.();

    // 認証器がキャンセル・エラーを返す状況
    let asked = 0;
    const handle = await boot(
      () => {
        asked += 1;
        return Promise.resolve(PASSPHRASE);
      },
      fakeAuthenticator({ failGet: true }),
    );
    expect(asked).toBe(1);
    expect(handle.replication).not.toBeNull();
    await Promise.all(
      Object.values(handle.replication ?? {}).map((state) => state.awaitInitialReplication()),
    );
    expect((await handle.db.chunks.findOne("p2").exec())?.content).toBe(
      "フォールバックで読めた記録",
    );
  });

  test("P3: 未対応ブラウザ（adapter なし）→ 従来どおりパスフレーズ・登録も不可", async () => {
    const dek = generateDek();
    await addPassphraseEnvelope(serverDb, dek, PASSPHRASE);
    const handle = await boot(() => Promise.resolve(PASSPHRASE), null);
    expect(handle.passkey.available).toBe(false);
    expect(handle.passkey.enroll).toBeNull();
    expect(handle.replication).not.toBeNull();
  });

  test("P4: アンロックできていない（封筒なし）状態では登録操作を出さない", async () => {
    const handle = await boot(() => Promise.resolve(PASSPHRASE), fakeAuthenticator());
    expect(handle.passkey.enroll).toBeNull();
    expect(handle.passkey.enrolled).toBe(false);
  });
});
