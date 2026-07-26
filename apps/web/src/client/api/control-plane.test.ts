import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateDek } from "@zakki/core/crypto/dek.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { Identity } from "@zakki/core/identity/types.ts";
import { addPassphraseEnvelope } from "@zakki/data/crypto/envelopes.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import { replDocs } from "@zakki/data/db/schema.ts";
import type { Hono } from "hono";
import { sign } from "hono/jwt";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import type { ControlPlaneClient } from "@zakki/web/client/api/control-plane.ts";
import {
  createControlPlaneClient,
  resolveRemoteSession,
} from "@zakki/web/client/api/control-plane.ts";
import type { TestAuthenticator, TestControlPlane } from "@zakki/web/client/api/test-control-plane.ts";
import { createTestControlPlane } from "@zakki/web/client/api/test-control-plane.ts";
import type { ClientDb } from "@zakki/web/client/db/bootstrap.ts";
import { bootstrapClientDb } from "@zakki/web/client/db/bootstrap.ts";
import { PRF_SALT } from "@zakki/web/client/db/passkey.ts";
import { testStorage } from "@zakki/web/client/db/test-db.ts";
import { createApp } from "@zakki/web/server/app.ts";
import { createRemoteDbResolver } from "@zakki/web/server/identity/remote.ts";

/**
 * issue #105: コントロールプレーン統合（RemoteIdentity）の受け入れ検証。
 *
 * 実物の apps/api（#100 の passkey 認証・#101 の DB プロビジョニング）と実物の
 * apps/web（replication 中継・封筒配布）を **プロセス内で繋いで** 通す。差し替えるのは
 * ローカルで再現できない 2 つだけ: Turso Platform API（#101 の fake）と認証器
 * （#100 の WebCrypto ソフトウェア認証器 + PRF）。メソッド単位の mock は使わない。
 *
 * ユーザごとの Turso DB もローカルには実体が無いので、中継サーバが DB を開く
 * アダプタ（`openUserDb`）にだけローカル libSQL を注入する——そこへ渡ってくる
 * Identity（dbUrl / token）が `GET /me/db` の応答そのものであることを検証する。
 */

const PASSPHRASE = "リモート構成テスト用パスフレーズ";

/** JWT の exp / iat 用（秒） */
const nowSec = (): number => Math.floor(Date.now() / 1000);

let cp: TestControlPlane;
/** 単一ユーザ self-host 用の DB（マルチユーザ構成では一切使われないことを検証する） */
let selfHostDb: Db;
let webApp: Hono;
let webFetch: FetchLike;
/** ブラウザの fetch に相当する 1 つの入口: /api/* は中継サーバ、それ以外はコントロールプレーン */
let routedFetch: FetchLike;
/** 中継サーバが開いたユーザごと DB（dbUrl → DB）と、その時渡された Identity */
let userDbs: Map<string, Db>;
let openedIdentities: Identity[];
let handles: ClientDb[] = [];
let nameSeq = 0;

beforeEach(async () => {
  await ready();
  cp = await createTestControlPlane();
  selfHostDb = await createDb(":memory:");
  userDbs = new Map();
  openedIdentities = [];
  webApp = createApp({
    db: selfHostDb,
    controlPlaneUrl: cp.baseUrl,
    resolveDb: createRemoteDbResolver({
      controlPlaneUrl: cp.baseUrl,
      fetchFn: cp.fetchFn,
      openUserDb: async (identity) => {
        openedIdentities.push(identity);
        const url = identity.tursoUrl ?? "";
        const existing = userDbs.get(url);
        if (existing !== undefined) return existing;
        const db = await createDb(":memory:");
        userDbs.set(url, db);
        return db;
      },
    }),
  });
  webFetch = async (input, init) => webApp.request(input, init);
  routedFetch = async (input, init) =>
    input.startsWith("/api/") ? webApp.request(input, init) : cp.fetchFn(input, init);
});

afterEach(async () => {
  await Promise.all(handles.map((h) => h.db.remove()));
  handles = [];
  await cp.stop();
});

/** 会員登録 → ログインまでを通し、クライアントと認証器を返す */
async function signUp(): Promise<{
  client: ControlPlaneClient;
  authenticator: TestAuthenticator;
  credentialId: string;
  prfOutput: Uint8Array | null;
}> {
  const authenticator = await cp.authenticator();
  const client = createControlPlaneClient({
    baseUrl: cp.baseUrl,
    credentials: authenticator,
    fetchFn: routedFetch,
  });
  const { credentialId } = await client.register();
  const { prfOutput } = await client.login();
  return { client, authenticator, credentialId, prfOutput };
}

/** リモート構成でクライアント DB を起動する（storage / prompt は注入） */
async function boot(options: {
  client: ControlPlaneClient;
  authenticator: TestAuthenticator;
  prfOutput?: Uint8Array | null;
  promptFn?: (attempt: number) => Promise<string | null>;
}): Promise<ClientDb> {
  nameSeq += 1;
  const handle = await bootstrapClientDb({
    storage: testStorage(),
    dbName: `zakkiremote${nameSeq}`,
    fetchFn: options.client.authorizedFetch,
    credentialsApi: options.authenticator,
    promptFn: options.promptFn ?? (() => Promise.resolve(null)),
    ...(options.prfOutput === undefined ? {} : { prfOutput: options.prfOutput }),
    replicationOptions: { live: false },
  });
  handles.push(handle);
  return handle;
}

describe("RemoteIdentity（コントロールプレーン統合）", () => {
  test("R1: 登録 → ログイン → /me/db → 接続情報が RemoteIdentity に反映される", async () => {
    const { client } = await signUp();
    const session = client.session();
    const identity = await client.identity();

    expect(session).not.toBeNull();
    expect(identity.userId).toBe(session?.accountId ?? "");
    // fake Platform API が返すホスト名（実 API と同じ形）が dbUrl になる
    expect(identity.tursoUrl).toMatch(/^libsql:\/\/zakki-.*\.turso\.io$/);
    expect(identity.tursoToken).not.toBe("");
    // Identity に鍵材料は載らない（E2E: 復号鍵はコントロールプレーンに存在しない）
    expect(identity.encKey).toBeUndefined();
  });

  test("R2: ログインの WebAuthn get は 1 回で、assertion と PRF 出力を同時に得る", async () => {
    const authenticator = await cp.authenticator();
    let gets = 0;
    const counted = {
      ...authenticator,
      get: async (options: CredentialRequestOptions) => {
        gets += 1;
        return authenticator.get(options);
      },
    };
    const client = createControlPlaneClient({
      baseUrl: cp.baseUrl,
      credentials: counted,
      fetchFn: routedFetch,
    });
    await client.register();
    const { session, prfOutput } = await client.login();

    expect(gets).toBe(1);
    expect(session.accountId).not.toBe("");
    // 同じ get の clientExtensionResults から取り出した PRF 出力（32 バイト）
    expect(prfOutput).not.toBeNull();
    expect([...(prfOutput ?? [])]).toEqual([...authenticator.prfFor(PRF_SALT)]);
  });

  test("R3: PRF 出力・DEK はコントロールプレーンへの wire に現れない", async () => {
    const { authenticator } = await signUp();
    const prf = authenticator.prfFor(PRF_SALT);
    const encodings = [
      Buffer.from(prf).toString("base64"),
      Buffer.from(prf).toString("base64url"),
      Buffer.from(prf).toString("hex"),
    ];
    expect(cp.requests.length).toBeGreaterThan(0);
    for (const { body } of cp.requests) {
      for (const encoded of encodings) expect(body).not.toContain(encoded);
      // 未署名の拡張結果はそもそも送らない（サーバも読まない）
      expect(body).not.toContain("clientExtensionResults");
      expect(body).not.toContain("prf");
    }
  });

  test("R4: セッション JWT は永続ストレージへ書かれない", async () => {
    const writes: string[] = [];
    const recorder = {
      getItem: () => null,
      setItem: (key: string) => writes.push(key),
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    };
    Object.defineProperty(globalThis, "localStorage", { value: recorder, configurable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: recorder, configurable: true });
    try {
      const { client } = await signUp();
      await client.identity();
      expect(writes).toEqual([]);
      // 別インスタンス（＝リロード相当）は何も引き継がない
      const fresh = createControlPlaneClient({
        baseUrl: cp.baseUrl,
        credentials: await cp.authenticator(),
        fetchFn: routedFetch,
      });
      expect(fresh.session()).toBeNull();
      // bun の rejects matcher は await できない型を返すため、明示的に捕まえて検証する
      let rejected = false;
      try {
        await fresh.connect();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });

  test("R5: 中継サーバは /me/db の接続情報でユーザごと DB を開く（self-host DB は使わない）", async () => {
    const { client } = await signUp();
    const identity = await client.identity();
    const res = await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    expect(res.status).toBe(200);

    // openUserDb へ渡ったのは /me/db の応答そのもの（クライアントの申告ではない）
    expect(openedIdentities.length).toBe(1);
    expect(openedIdentities[0]?.tursoUrl).toBe(identity.tursoUrl ?? "");
    expect(openedIdentities[0]?.userId).toBe(identity.userId);
    expect(userDbs.size).toBe(1);
  });

  test("R6: 未認証のリクエストは中継されない（401）", async () => {
    const pull = await webFetch("/api/replication/chunks/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoint: null, limit: 10 }),
    });
    expect(pull.status).toBe(401);
    const envelopes = await webFetch("/api/crypto/envelopes", { method: "GET" });
    expect(envelopes.status).toBe(401);
    // 解決に失敗したので DB は 1 つも開かれない
    expect(userDbs.size).toBe(0);
  });

  test("R6b: Bearer 以外の Authorization ヘッダも認証扱いにしない", async () => {
    const res = await webFetch("/api/crypto/envelopes", {
      method: "GET",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect(userDbs.size).toBe(0);
  });

  test("R6d: 別の鍵で署名した Bearer は中継層で弾く（この PR が作った認可境界の直接検証）", async () => {
    const { client } = await signUp();
    // 正規セッションで一度通し、DB が開かれた状態を作る
    const ok = await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    expect(ok.status).toBe(200);
    const opened = userDbs.size;

    // 形は正しいが署名鍵が違う JWT（＝偽造セッション）
    const forged = await sign({ sub: "他人の accountId", exp: nowSec() + 3600 }, "wrong-secret");
    const res = await webFetch("/api/crypto/envelopes", {
      method: "GET",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
    // 解決に失敗するので DB は増えない（他人の DB を開かせられない）
    expect(userDbs.size).toBe(opened);
  });

  test("R6d2: 期限切れの Bearer も中継層で弾く", async () => {
    const expired = await sign(
      { sub: "期限切れセッション", exp: nowSec() - 60 },
      "test-session-secret",
    );
    const res = await webFetch("/api/crypto/envelopes", {
      method: "GET",
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.status).toBe(401);
    expect(userDbs.size).toBe(0);
  });

  test("R6e: 起動直後に解決が並行しても DB は 1 つしか開かない（migrate 多重を防ぐ）", async () => {
    const { client } = await signUp();
    const before = cp.requests.length;

    // ブラウザ起動直後の実際の形: 封筒取得と各 collection の replication が同時に走る
    const results = await Promise.all([
      client.authorizedFetch("/api/crypto/envelopes", { method: "GET" }),
      client.authorizedFetch("/api/crypto/envelopes", { method: "GET" }),
      client.authorizedFetch("/api/crypto/envelopes", { method: "GET" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);

    // 解決は 1 回だけ = openUserDb も /auth/me + /me/db も 1 セットで済む
    expect(openedIdentities.length).toBe(1);
    expect(userDbs.size).toBe(1);
    expect(cp.requests.length - before).toBe(2);
  });

  test("R6c: 同じセッションの 2 回目は解決をやり直さない（DB は 1 つだけ開く）", async () => {
    const { client } = await signUp();
    await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    const after = cp.requests.length;
    await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });

    // 2 回目はコントロールプレーンへ問い合わせない（DB ハンドルも作り直さない）
    expect(cp.requests.length).toBe(after);
    expect(openedIdentities.length).toBe(1);
  });

  test("R7: アカウントごとに別の DB へ中継される", async () => {
    const first = await signUp();
    const second = await signUp();
    const firstIdentity = await first.client.identity();
    const secondIdentity = await second.client.identity();
    expect(firstIdentity.tursoUrl).not.toBe(secondIdentity.tursoUrl ?? "");

    await first.client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    await second.client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    expect(userDbs.size).toBe(2);
  });

  test("R8: 自分の DB に対して E2E で読み書きでき、平文はどのサーバにも現れない", async () => {
    const { client, authenticator } = await signUp();
    // 中継先の DB を確定させてから、そこへ封筒を用意する（TUI / CLI でのプロビジョン相当）
    await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    const identity = await client.identity();
    const userDb = userDbs.get(identity.tursoUrl ?? "");
    if (userDb === undefined) throw new Error("ユーザ DB が開かれているはず");
    const dek = generateDek();
    await addPassphraseEnvelope(userDb, dek, PASSPHRASE);

    const handle = await boot({
      client,
      authenticator,
      promptFn: () => Promise.resolve(PASSPHRASE),
    });
    expect(handle.replication).not.toBeNull();
    const plaintext = "スマホから書いた記録";
    await handle.db.chunks.insert({
      id: "r8",
      parentId: null,
      position: 0,
      content: plaintext,
      date: null,
      polarity: null,
      updatedAt: "2026-07-26T00:00:00.000Z",
    });
    await handle.replication?.chunks.awaitInSync();

    // ユーザ DB には暗号文だけが載る
    const rows = await userDb.select().from(replDocs);
    expect(rows.length).toBe(1);
    expect(rows[0]?.data).not.toContain(plaintext);
    // self-host DB（中継サーバ自身の DB）は空のまま
    expect((await selfHostDb.select().from(replDocs)).length).toBe(0);
    // コントロールプレーンが受け取った本文にも平文は無い
    for (const { body } of cp.requests) expect(body).not.toContain(plaintext);
  });

  test("R9: ログインで得た PRF 出力だけで封筒が開く（追加の生体認証なし）", async () => {
    const { client, authenticator, credentialId } = await signUp();
    await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    const identity = await client.identity();
    const userDb = userDbs.get(identity.tursoUrl ?? "");
    if (userDb === undefined) throw new Error("ユーザ DB が開かれているはず");
    const dek = generateDek();
    await addPassphraseEnvelope(userDb, dek, PASSPHRASE);

    // パスフレーズで開いた状態から、同じパスキーの PRF で封筒を追加する（#104 の経路）
    const first = await boot({
      client,
      authenticator,
      promptFn: () => Promise.resolve(PASSPHRASE),
    });
    if (first.passkey.saveEnvelope === null) throw new Error("アンロック済みなら保存できるはず");
    await first.passkey.saveEnvelope(credentialId);

    // 再ログイン（get 1 回）→ その PRF 出力だけで無言アンロック。prompt は呼ばれない
    let gets = 0;
    const counted = {
      ...authenticator,
      get: async (options: CredentialRequestOptions) => {
        gets += 1;
        return authenticator.get(options);
      },
    };
    const reloaded = createControlPlaneClient({
      baseUrl: cp.baseUrl,
      credentials: counted,
      fetchFn: routedFetch,
    });
    const { prfOutput } = await reloaded.login();
    const second = await boot({
      client: reloaded,
      authenticator,
      prfOutput,
      promptFn: () => Promise.reject(new Error("パスフレーズを聞いてはいけない")),
    });
    expect(second.replication).not.toBeNull();
    expect(gets).toBe(1);
  });
});

describe("resolveRemoteSession（設定ベースの構成選択）", () => {
  test("R10: コントロールプレーン URL が無ければ null（従来の単一ユーザ経路）", async () => {
    const singleUser = createApp({ db: selfHostDb });
    const session = await resolveRemoteSession({
      fetchFn: async (input, init) => singleUser.request(input, init),
      credentials: await cp.authenticator(),
    });
    expect(session).toBeNull();

    // 無退行: 同じサーバに対しては従来どおり認証なしで封筒・replication が通る
    const res = await singleUser.request("/api/crypto/envelopes");
    expect(res.status).toBe(200);
  });

  test("R11: URL があればログインして RemoteIdentity を返す", async () => {
    const authenticator = await cp.authenticator();
    // 先に会員登録を済ませておく（ログイン UI が未実装の段階の想定）
    await createControlPlaneClient({
      baseUrl: cp.baseUrl,
      credentials: authenticator,
      fetchFn: routedFetch,
    }).register();

    // /api/config は中継サーバから、それ以外（/auth/*・/me/db）はコントロールプレーンから
    const session = await resolveRemoteSession({
      fetchFn: routedFetch,
      credentials: authenticator,
    });

    expect(session).not.toBeNull();
    expect(session?.identity.tursoUrl).toMatch(/^libsql:\/\//);
    expect(session?.prfOutput).not.toBeNull();
  });

  test("R12: ログインできない（未登録）ときは null に畳んでローカルのみで起動する", async () => {
    const session = await resolveRemoteSession({
      fetchFn: routedFetch,
      credentials: await cp.authenticator(),
    });
    expect(session).toBeNull();
  });
});
