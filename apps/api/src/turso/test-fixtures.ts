import { Hono } from "hono";
import * as v from "valibot";

/**
 * テスト専用の fake Turso Platform API（issue #101）。
 *
 * 本物の Turso はローカルで再現できない依存なので、~/.references/policy/testing.md
 * に従い**プロトコルレベル**で用意する: Hono で実際の API と同じ経路・同じ JSON 形
 * （https://docs.turso.tech/api-reference/databases/create,
 *  https://docs.turso.tech/api-reference/databases/create-token）を返すサーバを組み、
 * テストはこれをローカルの serve に載せて base URL を向ける。クライアントのメソッドは
 * 一切 mock しない——URL・認証ヘッダ・クエリ・ステータスの解釈まで実体で通す。
 *
 * プロダクションコードからは import しない（auth/test-fixtures.ts と同じ分離）。
 * このファイル自身も Workers 制約下（node 組込み・Bun 固有 API は禁止）で書く: Guard 5 の
 * 除外は *.test.ts だけなので、サーバの起動は呼び出し側のテストが行う。
 */

/** fake の観測点と故障注入の摘み。テストが直接書き換える */
export interface FakePlatformState {
  /** 作成済み DB: name → hostname */
  readonly databases: Map<string, string>;
  /** 受け取った DB 作成リクエスト（二重作成の検出に使う） */
  readonly createRequests: { name: string; group: string }[];
  /** 受け取ったトークン発行リクエスト（expiration / authorization の検証に使う） */
  readonly tokenRequests: { name: string; expiration: string; authorization: string }[];
  /** 非 null の間、DB 作成をこのステータスで失敗させる（上流障害の再現） */
  createStatus: number | null;
  /** 非 null の間、DB 取得をこのステータスで失敗させる */
  getStatus: number | null;
  /** 非 null の間、トークン発行をこのステータスで失敗させる */
  tokenStatus: number | null;
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

/** 故障注入用のレスポンス（Hono の c.json は型で許すステータスが限られるため素の Response） */
function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 本物の Turso が返すホスト名の形（`<db>-<org>.turso.io`）に寄せる */
function hostnameFor(name: string, organization: string): string {
  return `${name}-${organization}.turso.io`;
}

export function createFakePlatformApi(options: {
  organization: string;
  apiToken: string;
  group: string;
}): FakePlatformApi {
  const state: FakePlatformState = {
    databases: new Map(),
    createRequests: [],
    tokenRequests: [],
    createStatus: null,
    getStatus: null,
    tokenStatus: null,
    malformedCreate: false,
  };

  const app = new Hono();
  const base = "/v1/organizations/:org/databases";

  // Platform API トークンは組織スコープ。付いていなければ何もさせない
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${options.apiToken}`) {
      return c.json({ error: "authentication required" }, 401);
    }
    await next();
    return undefined;
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
    if (group !== options.group) {
      return c.json({ error: "group not found" }, 400);
    }
    if (state.databases.has(name)) {
      return c.json({ error: `database with name ${name} already exists` }, 409);
    }
    const hostname = hostnameFor(name, options.organization);
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
      // 実 API の既定は expiration=never / authorization=full-access。指定漏れを
      // 見分けたいので、テスト側では「送られてこなかった」を空文字で残す
      expiration: c.req.query("expiration") ?? "",
      authorization: c.req.query("authorization") ?? "",
    });
    return c.json({ jwt: `token-for-${name}-${state.tokenRequests.length}` });
  });

  return { app, state };
}
