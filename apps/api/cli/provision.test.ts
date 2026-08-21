import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createTursoPlatform, TURSO_DEFAULT_LOCATION } from "@zakki/core/turso/platform.ts";
import { createFakePlatformApi } from "@zakki/core/turso/test-fixtures.ts";
import { parseProvisionEnv } from "./env.ts";
import { provisionControlPlane } from "./provision.ts";

/**
 * ブートストラップ（`just provision`）の検証（issue #131）。
 *
 * 受け入れ条件そのものを縛る: 空の Turso 組織から group + コントロールプレーン DB が
 * 立ち上がること、2 回目以降が何も壊さないこと。ローカルで再現できない Turso Platform
 * API だけを fake（プロトコルレベル）へ差し替え、クライアントは実物を通す。
 */

const ORG = "zakki-org";
const GROUP = "zakki-group";
const API_TOKEN = "org-scoped-token";
const CONTROL_DB = "zakki-control-test";

const fake = createFakePlatformApi({ organization: ORG, apiToken: API_TOKEN });
const server = Bun.serve({ port: 0, fetch: fake.app.fetch });
const platform = createTursoPlatform({
  baseUrl: `http://127.0.0.1:${server.port}`,
  apiToken: API_TOKEN,
  organization: ORG,
  group: GROUP,
});

afterAll(() => {
  void server.stop(true);
});

/** 進捗ログは stderr 相当。テストでは捨てる */
const silent = (): void => undefined;

beforeEach(() => {
  fake.state.groups.clear();
  fake.state.createGroupRequests.length = 0;
  fake.state.databases.clear();
  fake.state.createRequests.length = 0;
  fake.state.tokenRequests.length = 0;
  fake.state.getStatus = null;
  fake.state.createStatus = null;
  fake.state.tokenStatus = null;
});

describe("provisionControlPlane", () => {
  test("空の組織から group と DB を作り、接続情報を返す", async () => {
    const result = await provisionControlPlane(platform, CONTROL_DB, silent);

    const endpoint = result._unsafeUnwrap();
    expect(endpoint.url).toBe(`libsql://${CONTROL_DB}-${ORG}.${TURSO_DEFAULT_LOCATION}.turso.io`);
    expect(endpoint.token).toBe(`token-for-${CONTROL_DB}-1`);
    expect(fake.state.createGroupRequests).toEqual([
      { name: GROUP, location: TURSO_DEFAULT_LOCATION },
    ]);
    expect(fake.state.createRequests).toEqual([{ name: CONTROL_DB, group: GROUP }]);
  });

  test("発行するトークンはこの DB スコープで無期限（Worker が常時使う）", async () => {
    expect((await provisionControlPlane(platform, CONTROL_DB, silent)).isOk()).toBe(true);

    expect(fake.state.tokenRequests).toEqual([
      { name: CONTROL_DB, expiration: "never", authorization: "full-access" },
    ]);
  });

  test("2 回目以降は何も作らず、トークンだけ新しく発行する", async () => {
    const first = (await provisionControlPlane(platform, CONTROL_DB, silent))._unsafeUnwrap();
    const second = (await provisionControlPlane(platform, CONTROL_DB, silent))._unsafeUnwrap();

    expect(second.url).toBe(first.url);
    expect(fake.state.createGroupRequests).toHaveLength(1);
    expect(fake.state.createRequests).toHaveLength(1);
    // Platform API に「発行済みトークンを読み出す」経路は無いので、再取得は再発行になる
    expect(second.token).not.toBe(first.token);
  });

  test("DB 作成が失敗したらトークンを発行しない", async () => {
    fake.state.createStatus = 500;

    const result = await provisionControlPlane(platform, CONTROL_DB, silent);

    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "status", status: 500 });
    expect(fake.state.tokenRequests).toEqual([]);
  });

  test("組織トークンが違えば 401 で止まり、何も作らない", async () => {
    const wrong = createTursoPlatform({
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: "wrong-token",
      organization: ORG,
      group: GROUP,
    });

    const result = await provisionControlPlane(wrong, CONTROL_DB, silent);

    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "status", status: 401 });
    expect(fake.state.groups.size).toBe(0);
    expect(fake.state.databases.size).toBe(0);
  });
});

describe("parseProvisionEnv", () => {
  test("組織トークンと組織名だけで動き、残りは既定値になる", () => {
    const config = parseProvisionEnv({
      TURSO_API_TOKEN: "tok",
      TURSO_ORG: "zakki-org",
    })._unsafeUnwrap();

    expect(config).toEqual({
      apiToken: "tok",
      organization: "zakki-org",
      group: "zakki",
      groupLocation: TURSO_DEFAULT_LOCATION,
      controlDbName: "zakki-control-prod",
    });
  });

  test("空文字列は未設定として既定値に畳む（`export FOO=` の取りこぼし対策）", () => {
    const config = parseProvisionEnv({
      TURSO_API_TOKEN: "tok",
      TURSO_ORG: "zakki-org",
      TURSO_GROUP: "",
    })._unsafeUnwrap();

    expect(config.group).toBe("zakki");
  });

  test("組織トークンが無ければどの変数が足りないかを示して失敗する", () => {
    const result = parseProvisionEnv({ TURSO_ORG: "zakki-org" });
    expect(result._unsafeUnwrapErr()).toContain("TURSO_API_TOKEN");
  });
});
