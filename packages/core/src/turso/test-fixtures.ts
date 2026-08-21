import { Hono } from "hono";
import * as v from "valibot";

/**
 * テスト専用の fake Turso Platform API（issue #101）。
 *
 * 本物の Turso はローカルで再現できない依存なので、~/.references/policy/testing.md
 * に従い**プロトコルレベル**で用意する: Hono で実際の API と同じ経路・同じ JSON 形
 * （https://docs.turso.tech/api-reference/groups/retrieve,
 *  https://docs.turso.tech/api-reference/groups/create,
 *  https://docs.turso.tech/api-reference/databases/create,
 *  https://docs.turso.tech/api-reference/databases/create-token,
 *  https://docs.turso.tech/api-reference/databases/delete）を返すサーバを組み、
 * テストはこれをローカルの serve に載せて base URL を向ける。クライアントのメソッドは
 * 一切 mock しない——URL・認証ヘッダ・クエリ・ステータスの解釈まで実体で通す。
 *
 * クライアント（platform.ts）と同じく packages/core に置く（issue #130）: apps/api と
 * ブートストラップ CLI の両方から使うため。プロダクションコードからは import しない
 * （apps/api/src/auth/test-fixtures.ts と同じ分離）。このファイル自身も Workers 制約下
 * （node 組込み・Bun 固有 API は禁止）で書く: サーバの起動は呼び出し側のテストが行う。
 */

/** fake の観測点と故障注入の摘み。テストが直接書き換える */
export interface FakePlatformState {
  /** 作成済み group: name → primary location。既定は空 = group の無い組織 */
  readonly groups: Map<string, string>;
  /** 受け取った group 作成リクエスト（二重作成・ロケーション指定の検出に使う） */
  readonly createGroupRequests: { name: string; location: string }[];
  /** 作成済み DB: name → hostname */
  readonly databases: Map<string, string>;
  /** 受け取った DB 作成リクエスト（二重作成の検出に使う） */
  readonly createRequests: { name: string; group: string }[];
  /** 受け取ったトークン発行リクエスト（expiration / authorization の検証に使う） */
  readonly tokenRequests: { name: string; expiration: string; authorization: string }[];
  /** 受け取った DB 削除リクエストの DB 名（退会が実際に何を消しに行ったかの検証に使う） */
  readonly deleteRequests: string[];
  /** 非 null の間、group 取得をこのステータスで失敗させる */
  getGroupStatus: number | null;
  /** 非 null の間、group 作成をこのステータスで失敗させる */
  createGroupStatus: number | null;
  /** 非 null の間、DB 作成をこのステータスで失敗させる（上流障害の再現） */
  createStatus: number | null;
  /** 非 null の間、DB 取得をこのステータスで失敗させる */
  getStatus: number | null;
  /** 非 null の間、トークン発行をこのステータスで失敗させる */
  tokenStatus: number | null;
  /** 非 null の間、DB 削除をこのステータスで失敗させる（退会の中断を再現する） */
  deleteStatus: number | null;
  /** true の間、作成レスポンスの形を壊す（スキーマ検証の確認用） */
  malformedCreate: boolean;
}

export interface FakePlatformApi {
  /** テスト側の serve に渡す fetch ハンドラを持つ Hono アプリ */
  readonly app: Hono;
  readonly state: FakePlatformState;
}

/** DB 作成リクエストの本文（実 API と同じく name と group が必須） */
const CreateRequestSchema = v.object({ name: v.string(), group: v.string() });

/** group 作成リクエストの本文（実 API と同じく name と location が必須） */
const CreateGroupRequestSchema = v.object({ name: v.string(), location: v.string() });

/** 故障注入用のレスポンス（Hono の c.json は型で許すステータスが限られるため素の Response） */
function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 本物の Turso が返すホスト名の形（`<db>-<org>.<location>.turso.io`）に寄せる */
function hostnameFor(name: string, organization: string, location: string): string {
  return `${name}-${organization}.${location}.turso.io`;
}

export function createFakePlatformApi(options: {
  organization: string;
  apiToken: string;
  /** 初期状態で存在する group。既定は空 = 空の組織（group もアプリが作る, issue #130） */
  groups?: Readonly<Record<string, string>>;
}): FakePlatformApi {
  const state: FakePlatformState = {
    groups: new Map(Object.entries(options.groups ?? {})),
    createGroupRequests: [],
    databases: new Map(),
    createRequests: [],
    tokenRequests: [],
    deleteRequests: [],
    getGroupStatus: null,
    createGroupStatus: null,
    createStatus: null,
    getStatus: null,
    tokenStatus: null,
    deleteStatus: null,
    malformedCreate: false,
  };

  const app = new Hono();
  const base = "/v1/organizations/:org/databases";
  const groupsBase = "/v1/organizations/:org/groups";

  // Platform API トークンは組織スコープ。付いていなければ何もさせない
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${options.apiToken}`) {
      return c.json({ error: "authentication required" }, 401);
    }
    await next();
    return undefined;
  });

  app.get(`${groupsBase}/:name`, (c) => {
    if (state.getGroupStatus !== null) {
      return fail(state.getGroupStatus, "internal error");
    }
    const name = c.req.param("name");
    const location = state.groups.get(name);
    if (location === undefined) {
      return c.json({ error: "group not found" }, 404);
    }
    return c.json({ group: { name, locations: [location], primary: location } });
  });

  app.post(groupsBase, async (c) => {
    if (c.req.param("org") !== options.organization) {
      return c.json({ error: "organization not found" }, 404);
    }
    if (state.createGroupStatus !== null) {
      return fail(state.createGroupStatus, "internal error");
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = v.safeParse(CreateGroupRequestSchema, body);
    if (!parsed.success) {
      return c.json({ error: "invalid request" }, 400);
    }
    const { name, location } = parsed.output;
    state.createGroupRequests.push({ name, location });
    // 現行 API は旧 3 文字コード（nrt 等）を弾く（2026-08-19 実測, issue #129）。
    // ロケーション形式の取り違えがテストで死ぬように fake でも同じ扱いにする
    if (!location.startsWith("aws-")) {
      return c.json({ error: "invalid location" }, 400);
    }
    if (state.groups.has(name)) {
      return c.json({ error: "group already exists" }, 409);
    }
    state.groups.set(name, location);
    return c.json({ group: { name, primary: location } });
  });

  app.post(base, async (c) => {
    if (c.req.param("org") !== options.organization) {
      return c.json({ error: "organization not found" }, 404);
    }
    if (state.createStatus !== null) {
      return fail(state.createStatus, "internal error");
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = v.safeParse(CreateRequestSchema, body);
    if (!parsed.success) {
      return c.json({ error: "invalid request" }, 400);
    }
    const { name, group } = parsed.output;
    state.createRequests.push({ name, group });
    const location = state.groups.get(group);
    if (location === undefined) {
      return c.json({ error: "group not found" }, 400);
    }
    if (state.databases.has(name)) {
      return c.json({ error: `database with name ${name} already exists` }, 409);
    }
    const hostname = hostnameFor(name, options.organization, location);
    state.databases.set(name, hostname);
    if (state.malformedCreate) {
      return c.json({ database: { Name: name } });
    }
    return c.json({ database: { DbId: `db-${name}`, Hostname: hostname, Name: name } });
  });

  app.get(`${base}/:name`, (c) => {
    if (state.getStatus !== null) {
      return fail(state.getStatus, "internal error");
    }
    const name = c.req.param("name");
    const hostname = state.databases.get(name);
    if (hostname === undefined) {
      return c.json({ error: "database not found" }, 404);
    }
    return c.json({ database: { DbId: `db-${name}`, Hostname: hostname, Name: name } });
  });

  app.delete(`${base}/:name`, (c) => {
    // 故障注入より先に記録する: 「失敗したがちゃんと消しに行った」ことを
    // テストが観測できるようにするため（退会の再試行の検証に要る）
    state.deleteRequests.push(c.req.param("name"));
    if (state.deleteStatus !== null) {
      return fail(state.deleteStatus, "internal error");
    }
    const name = c.req.param("name");
    if (!state.databases.delete(name)) {
      // 実 API の 404 本文に合わせる（クライアントは成功に畳む）
      return c.json({ error: `could not find database with name ${name}: record not found` }, 404);
    }
    // 実 API は削除した DB 名を文字列で返す（作成・取得のオブジェクト形とは違う）
    return c.json({ database: name });
  });

  app.post(`${base}/:name/auth/tokens`, (c) => {
    if (state.tokenStatus !== null) {
      return fail(state.tokenStatus, "internal error");
    }
    const name = c.req.param("name");
    if (!state.databases.has(name)) {
      return c.json({ error: "database not found" }, 404);
    }
    state.tokenRequests.push({
      name,
      // 実 API の既定は expiration=never / authorization=full-access
      // （https://docs.turso.tech/api-reference/databases/create-token）。
      // 記録するのは**実効値**——指定漏れは「無期限のトークンを配った」という
      // 実害そのものとして観測されるべきで、空文字では意味が伝わらない
      expiration: c.req.query("expiration") ?? "never",
      authorization: c.req.query("authorization") ?? "full-access",
    });
    return c.json({ jwt: `token-for-${name}-${state.tokenRequests.length}` });
  });

  return { app, state };
}
