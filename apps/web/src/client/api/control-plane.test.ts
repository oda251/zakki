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
  readLoginFragment,
  resolveRemoteSession,
} from "@zakki/web/client/api/control-plane.ts";
import type { TestControlPlane } from "@zakki/web/client/api/test-control-plane.ts";
import { createTestControlPlane } from "@zakki/web/client/api/test-control-plane.ts";
import type { ClientDb } from "@zakki/web/client/db/bootstrap.ts";
import { bootstrapClientDb } from "@zakki/web/client/db/bootstrap.ts";
import { testStorage } from "@zakki/web/client/db/test-db.ts";
import { createApp } from "@zakki/web/server/app.ts";
import { createRemoteUserResolver } from "@zakki/web/server/identity/remote.ts";

/**
 * issue #105: コントロールプレーン統合（RemoteIdentity）の受け入れ検証。
 *
 * 実物の apps/api（OIDC ログイン・#101 の DB プロビジョニング）と実物の
 * apps/web（replication 中継・封筒配布）を **プロセス内で繋いで** 通す。差し替えるのは
 * ローカルで再現できない 2 つだけ: Turso Platform API（#101 の fake）と ID プロバイダ
 * （fake OIDC プロバイダ）。メソッド単位の mock は使わない。
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
/**
 * 中継サーバの時計（ms）。既定は実時刻で、セッション再検証（issue #117）の
 * 経過を作るテストだけがこれを進める（実時間を待たない）。
 */
let relayNowMs = Date.now();
/** true の間、中継サーバからコントロールプレーンへの問い合わせを 503 にする */
let controlPlaneDown = false;

beforeEach(async () => {
  await ready();
  cp = await createTestControlPlane();
  selfHostDb = await createDb(":memory:");
  userDbs = new Map();
  openedIdentities = [];
  relayNowMs = Date.now();
  controlPlaneDown = false;
  webApp = createApp({
    db: selfHostDb,
    controlPlaneUrl: cp.baseUrl,
    resolveUser: createRemoteUserResolver({
      controlPlaneUrl: cp.baseUrl,
      // 上流の一時障害を差し込めるようにする（既定は素通し）
      fetchFn: (input, init) =>
        controlPlaneDown
          ? Promise.resolve(new Response("down", { status: 503 }))
          : cp.fetchFn(input, init),
      now: () => relayNowMs,
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

let subjectSeq = 0;

/** Google で同意して戻ってきた fragment から handoff code を取り出す */
async function authorizeCode(subject: string): Promise<string> {
  const fragment = readLoginFragment(await cp.authorize(subject));
  if (fragment?.kind !== "code") throw new Error(`ログインできていない: ${JSON.stringify(fragment)}`);
  return fragment.code;
}

/** 新しい利用者として初回ログインまでを通し、クライアントを返す */
async function signUp(): Promise<{ client: ControlPlaneClient; subject: string }> {
  subjectSeq += 1;
  const subject = `sub-${subjectSeq}`;
  const client = createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch });
  await client.completeLogin(await authorizeCode(subject));
  return { client, subject };
}

/** セッション JWT を載せた GET のリクエスト設定 */
function authorized(token: string): RequestInit {
  return { method: "GET", headers: { authorization: `Bearer ${token}` } };
}

/** 退会（apps/api の `DELETE /me`, issue #116）。UI はまだ無いので直接叩く */
async function deleteAccount(token: string): Promise<Response> {
  return cp.fetchFn(`${cp.baseUrl}/me`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 全端末ログアウト（apps/api の `POST /auth/logout`, issue #117）。UI はまだ無い */
async function logout(token: string): Promise<Response> {
  return cp.fetchFn(`${cp.baseUrl}/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 中継サーバの時計を進める（セッション再検証の間隔を跨がせる, issue #117） */
function advanceRelayClock(seconds: number): void {
  relayNowMs += seconds * 1000;
}

/** リモート構成でクライアント DB を起動する（storage / prompt は注入） */
async function boot(options: {
  client: ControlPlaneClient;
  promptFn?: (attempt: number) => Promise<string | null>;
}): Promise<ClientDb> {
  nameSeq += 1;
  const handle = await bootstrapClientDb({
    storage: testStorage(),
    dbName: `zakkiremote${nameSeq}`,
    fetchFn: options.client.authorizedFetch,
    // E2E のパスキーアンロックはログインと切り離した（この検証はパスフレーズで開く）
    credentialsApi: null,
    promptFn: options.promptFn ?? (() => Promise.resolve(null)),
    replicationOptions: { live: false },
  });
  handles.push(handle);
  return handle;
}

describe("RemoteIdentity（コントロールプレーン統合）", () => {
  test("R1: ログイン → /me/db → 接続情報が RemoteIdentity に反映される", async () => {
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

  test("R2: 同じ Google アカウントで入り直すと同じアカウント（同じ DB）に戻る", async () => {
    const { client, subject } = await signUp();
    const again = createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch });
    const session = await again.completeLogin(await authorizeCode(subject));
    expect(session.accountId).toBe(client.session()?.accountId ?? "");
    expect((await again.identity()).tursoUrl).toBe((await client.identity()).tursoUrl ?? "");
  });

  test("R3: handoff code は一度しか使えない（URL に残った code を再利用できない）", async () => {
    const code = await authorizeCode("sub-replay");
    const first = createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch });
    await first.completeLogin(code);
    const second = createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch });
    let rejected = false;
    try {
      await second.completeLogin(code);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(second.session()).toBeNull();
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
      const fresh = createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch });
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

  test("R6f: 退会したアカウントのセッションは中継されない（issue #116）", async () => {
    const { client } = await signUp();
    const token = client.session()?.token ?? "";
    expect((await deleteAccount(token)).status).toBe(204);

    // 中継サーバは /auth/me で「あなたは誰か」を解決する。退会済みは 401 なので
    // 解決不能になり、ユーザ DB は 1 つも開かれない
    const res = await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    expect(res.status).toBe(401);
    expect(userDbs.size).toBe(0);
  });

  test("R6g: 退会前に解決済みのセッションも再検証の間隔で中継が止まる（issue #116 / #117）", async () => {
    const { client } = await signUp();
    // 先に中継を通しておく（= 解決結果が中継サーバのキャッシュに載る）
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);
    const token = client.session()?.token ?? "";
    expect((await deleteAccount(token)).status).toBe(204);
    expect((await cp.fetchFn(`${cp.baseUrl}/auth/me`, authorized(token))).status).toBe(401);

    // 再検証の間隔（60 秒）内はキャッシュがそのまま使われる。ここが失効の遅延そのもの
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);

    // 間隔を跨ぐと `/auth/me` を叩き直し、401 を受けて中継が止まる
    advanceRelayClock(61);
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(401);
  });

  test("R6h: ログアウトすると再検証の間隔内に中継が止まる（issue #117）", async () => {
    const { client } = await signUp();
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);
    const token = client.session()?.token ?? "";

    expect((await logout(token)).status).toBe(204);
    // コントロールプレーン側は即座に 401（epoch 不一致）
    expect((await cp.fetchFn(`${cp.baseUrl}/auth/me`, authorized(token))).status).toBe(401);

    advanceRelayClock(61);
    const res = await client.authorizedFetch("/api/crypto/envelopes");
    expect(res.status).toBe(401);
    // 中継が止まってもユーザ DB は消えない（退会と違い、再ログインで戻れる）
    expect(userDbs.size).toBe(1);
  });

  test("R6i: 再検証は間隔ごとに 1 往復だけ（ヒットのたびにコントロールプレーンを叩かない）", async () => {
    const { client } = await signUp();
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);

    // 同じ間隔の中は何度叩いても問い合わせゼロ
    const afterResolve = cp.requests.length;
    await client.authorizedFetch("/api/crypto/envelopes");
    await client.authorizedFetch("/api/crypto/envelopes");
    expect(cp.requests.length).toBe(afterResolve);

    // 間隔を跨いだ最初の 1 本だけが `/auth/me` を叩く（`/me/db` は叩き直さない）
    advanceRelayClock(61);
    const results = await Promise.all([
      client.authorizedFetch("/api/crypto/envelopes"),
      client.authorizedFetch("/api/crypto/envelopes"),
      client.authorizedFetch("/api/crypto/envelopes"),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(cp.requests.length - afterResolve).toBe(1);
    // DB ハンドルは開き直さない（閉じる手段が無いので、再検証で増やしてはいけない）
    expect(openedIdentities.length).toBe(1);
    expect(userDbs.size).toBe(1);
  });

  test("R6j: ログアウト後に再ログインすれば新しいセッションで中継が通る", async () => {
    const { client, subject } = await signUp();
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);
    const oldToken = client.session()?.token ?? "";
    expect((await logout(oldToken)).status).toBe(204);
    advanceRelayClock(61);
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(401);

    // 同じ Google アカウントで入り直す（新しい世代のトークンが出る）
    const reloaded = createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch });
    await reloaded.completeLogin(await authorizeCode(subject));
    expect(reloaded.session()?.token).not.toBe(oldToken);
    expect((await reloaded.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);
    // 戻り先は同じユーザ DB（ログアウトはデータに触らない）
    expect(userDbs.size).toBe(1);
  });

  test("R6k: 上流の一時障害では失効扱いにせず、復旧後に再検証をやり直す", async () => {
    const { client } = await signUp();
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);
    const opened = openedIdentities.length;

    // 再検証の頃合いにコントロールプレーンが 5xx を返す。ここでキャッシュを捨てると
    // その場が 401 に見えるうえ、復旧後の再解決で閉じられない DB ハンドルが増える
    advanceRelayClock(61);
    controlPlaneDown = true;
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);
    expect(openedIdentities.length).toBe(opened);

    // 復旧後は再検証をやり直す（verifiedAt を進めていないので次の 1 本で問い合わせる）
    controlPlaneDown = false;
    const before = cp.requests.length;
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(200);
    expect(cp.requests.length).toBeGreaterThan(before);

    // 障害中に失効していたなら、復旧後の再検証で 401 になる
    const token = client.session()?.token ?? "";
    expect((await logout(token)).status).toBe(204);
    advanceRelayClock(61);
    expect((await client.authorizedFetch("/api/crypto/envelopes")).status).toBe(401);
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
    const { client } = await signUp();
    // 中継先の DB を確定させてから、そこへ封筒を用意する（TUI / CLI でのプロビジョン相当）
    await client.authorizedFetch("/api/crypto/envelopes", { method: "GET" });
    const identity = await client.identity();
    const userDb = userDbs.get(identity.tursoUrl ?? "");
    if (userDb === undefined) throw new Error("ユーザ DB が開かれているはず");
    const dek = generateDek();
    await addPassphraseEnvelope(userDb, dek, PASSPHRASE);

    const handle = await boot({ client, promptFn: () => Promise.resolve(PASSPHRASE) });
    expect(handle.replication).not.toBeNull();
    const plaintext = "スマホから書いた記録";
    await handle.db.chunks.insert({
      id: "r8",
      parentId: null,
      position: 0,
      kind: "text",
      fileId: null,
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
});

describe("readLoginFragment", () => {
  test("R13: #login=<code> は code", () => {
    expect(readLoginFragment("#login=abc")).toEqual({ kind: "code", code: "abc" });
  });

  test("R14: #login_error=<reason> はエラー理由", () => {
    expect(readLoginFragment("#login_error=denied")).toEqual({ kind: "error", reason: "denied" });
  });

  test("R15: ログインと無関係な fragment・空は null", () => {
    expect(readLoginFragment("")).toBeNull();
    expect(readLoginFragment("#")).toBeNull();
    expect(readLoginFragment("#section-2")).toBeNull();
    expect(readLoginFragment("#login=")).toBeNull();
  });
});

describe("resolveRemoteSession（設定ベースの構成選択）", () => {
  test("R10: コントロールプレーン URL が無ければ null（従来の単一ユーザ経路）", async () => {
    const singleUser = createApp({ db: selfHostDb });
    const session = await resolveRemoteSession({
      fetchFn: async (input, init) => singleUser.request(input, init),
      hash: "",
      clearHash: () => undefined,
    });
    expect(session).toBeNull();

    // 無退行: 同じサーバに対しては従来どおり認証なしで封筒・replication が通る
    const res = await singleUser.request("/api/crypto/envelopes");
    expect(res.status).toBe(200);
  });

  test("R11: fragment に handoff code があればセッションを得て RemoteIdentity を返し、fragment を消す", async () => {
    const hash = await cp.authorize("sub-r11");
    let cleared = 0;
    // /api/config は中継サーバから、それ以外（/auth/*・/me/db）はコントロールプレーンから
    const session = await resolveRemoteSession({
      fetchFn: routedFetch,
      hash,
      clearHash: () => {
        cleared += 1;
      },
    });

    expect(session?.status).toBe("signed-in");
    if (session?.status !== "signed-in") throw new Error("ログイン済みのはず");
    expect(session.identity.tursoUrl).toMatch(/^libsql:\/\//);
    expect((await session.fetchFn("/api/crypto/envelopes")).status).toBe(200);
    // code は単回使用で、URL（履歴）に残しておく意味が無い
    expect(cleared).toBe(1);
  });

  test("R12: fragment が無ければ未ログイン。プロバイダ一覧と開始 URL を返す", async () => {
    const session = await resolveRemoteSession({
      fetchFn: routedFetch,
      hash: "",
      clearHash: () => undefined,
    });
    expect(session).toEqual({
      status: "signed-out",
      providers: [
        { id: "google", name: "Google", loginUrl: `${cp.baseUrl}/auth/oidc/google/start` },
      ],
      error: null,
    });
  });

  test("R16: プロバイダが拒否を返した（#login_error=denied）ら未ログイン + エラー理由", async () => {
    let cleared = 0;
    const session = await resolveRemoteSession({
      fetchFn: routedFetch,
      hash: "#login_error=denied",
      clearHash: () => {
        cleared += 1;
      },
    });
    expect(session?.status).toBe("signed-out");
    if (session?.status !== "signed-out") throw new Error("未ログインのはず");
    expect(session.error).toBe("denied");
    expect(cleared).toBe(1);
  });

  test("R17: code の交換に失敗（使用済み）したら未ログイン + exchange エラー", async () => {
    const hash = await cp.authorize("sub-r17");
    const fragment = readLoginFragment(hash);
    if (fragment?.kind !== "code") throw new Error("code のはず");
    // 先に誰かが使った（= リロードで同じ URL を開き直した）状態
    await createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch }).completeLogin(
      fragment.code,
    );

    const session = await resolveRemoteSession({
      fetchFn: routedFetch,
      hash,
      clearHash: () => undefined,
    });
    expect(session?.status).toBe("signed-out");
    if (session?.status !== "signed-out") throw new Error("未ログインのはず");
    expect(session.error).toBe("exchange");
    expect(session.providers.map((p) => p.id)).toEqual(["google"]);
  });
});

describe("アカウント表示とログアウト（issue #159）", () => {
  test("R18: logout() は POST /auth/logout を呼び、セッションを捨てる", async () => {
    const { client } = await signUp();
    const session = client.session();
    if (session === null) throw new Error("ログイン済みのはず");
    const before = cp.requests.length;

    await client.logout();

    // サーバへはログアウトの 1 往復だけ（認証ヘッダ付き）
    expect(cp.requests.length).toBe(before + 1);
    expect(cp.requests[before]?.url).toBe(`${cp.baseUrl}/auth/logout`);
    // メモリのセッションは消え、以後 connect() は 401（requireSession）
    expect(client.session()).toBeNull();
  });

  test("R19: 未ログインの logout() は no-op（fetch を発行しない）", async () => {
    const client = createControlPlaneClient({ baseUrl: cp.baseUrl, fetchFn: routedFetch });
    const before = cp.requests.length;
    await client.logout();
    expect(cp.requests.length).toBe(before);
  });

  test("R20: ログインの全経路（completeLogin → resolveRemoteSession）で表示用の account が届く", async () => {
    // 直接の client.completeLogin の戻り値にも、起動フロー（resolveRemoteSession が
    // 内部で completeLogin を呼ぶ）の結果にも account が載る。main.tsx は後者を使う
    const { client, subject } = await signUp();
    expect(client.session()?.account).toEqual({
      email: `${subject}@example.com`,
      provider: { id: "google", name: "Google" },
    });
    const hash = await cp.authorize("sub-r20");
    const session = await resolveRemoteSession({
      fetchFn: routedFetch,
      hash,
      clearHash: () => undefined,
    });
    if (session?.status !== "signed-in") throw new Error("signed-in のはず");
    expect(session.client.session()?.account).toEqual({
      email: "sub-r20@example.com",
      provider: { id: "google", name: "Google" },
    });
  });
});
