import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createTursoPlatform,
  TURSO_DEFAULT_LOCATION,
  type TursoPlatform,
} from "@zakki/core/turso/platform.ts";
import { createFakePlatformApi } from "@zakki/core/turso/test-fixtures.ts";

/**
 * Turso Platform クライアントのプロトコル検証（issue #130）。
 *
 * 本物の Turso はローカルで再現できないので、fake（test-fixtures.ts）を実サーバに
 * 載せて base URL を向ける。クライアントのメソッドは mock しない——URL・認証ヘッダ・
 * リクエスト本文・ステータスの解釈まで実体で通す。
 *
 * DB 側の操作（作成・取得・トークン・削除）はプロビジョニング経路の統合テスト
 * （apps/api/src/routes/me.test.ts）が実 API 形で通しているので、ここは group の
 * 存在保証——移設と同時に足した唯一の新しい振る舞い——に絞る。
 *
 * fake を実サーバに載せるため `Bun.serve` を使う。core の「ランタイム非依存」は
 * 配布されるコードの制約で、テストは元々 bun test 前提（.oxlintrc.json の test
 * override が bun:* import を許しているのと同じ理由）のため、同じ override で
 * Bun グローバルも許している。
 */

const ORG = "zakki-org";
const GROUP = "zakki-group";
const API_TOKEN = "platform-api-token";

const fake = createFakePlatformApi({ organization: ORG, apiToken: API_TOKEN });
const server = Bun.serve({ port: 0, fetch: fake.app.fetch });
const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

function platform(overrides: { apiToken?: string; groupLocation?: string } = {}): TursoPlatform {
  return createTursoPlatform({
    baseUrl,
    apiToken: overrides.apiToken ?? API_TOKEN,
    organization: ORG,
    group: GROUP,
    groupLocation: overrides.groupLocation,
  });
}

beforeEach(() => {
  fake.state.groups.clear();
  fake.state.createGroupRequests.length = 0;
  fake.state.getGroupStatus = null;
  fake.state.createGroupStatus = null;
});

describe("ensureGroup", () => {
  test("group が無ければ既定ロケーションで作る", async () => {
    const result = await platform().ensureGroup();
    expect(result.isOk()).toBe(true);
    expect(fake.state.createGroupRequests).toEqual([
      { name: GROUP, location: TURSO_DEFAULT_LOCATION },
    ]);
    expect(fake.state.groups.get(GROUP)).toBe(TURSO_DEFAULT_LOCATION);
  });

  test("group が既にあれば作りに行かない（冪等）", async () => {
    expect((await platform().ensureGroup()).isOk()).toBe(true);
    expect((await platform().ensureGroup()).isOk()).toBe(true);
    expect(fake.state.createGroupRequests).toHaveLength(1);
  });

  test("ロケーションを指定できる", async () => {
    expect((await platform({ groupLocation: "aws-us-east-1" }).ensureGroup()).isOk()).toBe(true);
    expect(fake.state.createGroupRequests[0]?.location).toBe("aws-us-east-1");
  });

  test("旧 3 文字コードのロケーションは実 API と同じく弾かれる", async () => {
    // 現行 API は `nrt` を 400 invalid location で拒む（2026-08-19 実測, issue #129）。
    // 設定を旧形式に戻したら気づけることを担保する
    const result = await platform({ groupLocation: "nrt" }).ensureGroup();
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "status",
      status: 400,
      detail: expect.stringContaining("invalid location"),
    });
  });

  test("取得と作成の間に他の実行者が作っていたら（409）成功に畳む", async () => {
    // 並行プロビジョニングの再現: GET は 404 を返させ、その裏で group を作っておく
    fake.state.getGroupStatus = 404;
    fake.state.groups.set(GROUP, TURSO_DEFAULT_LOCATION);

    const result = await platform().ensureGroup();
    expect(result.isOk()).toBe(true);
    expect(fake.state.createGroupRequests).toHaveLength(1);
  });

  test("取得が 404 以外で失敗したら、無いと決めつけて作りに行かない", async () => {
    fake.state.getGroupStatus = 500;
    const result = await platform().ensureGroup();
    expect(result._unsafeUnwrapErr().kind).toBe("status");
    expect(fake.state.createGroupRequests).toEqual([]);
  });

  test("作成が失敗したらそのまま失敗を返す", async () => {
    fake.state.createGroupStatus = 500;
    const result = await platform().ensureGroup();
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "status", status: 500 });
    expect(fake.state.groups.size).toBe(0);
  });

  test("Platform API トークンが違えば 401（組織スコープの認証を実際に通す）", async () => {
    const result = await platform({ apiToken: "wrong-token" }).ensureGroup();
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "status", status: 401 });
    expect(fake.state.createGroupRequests).toEqual([]);
  });

  test("API へ到達できなければ unreachable", async () => {
    const unreachable = createTursoPlatform({
      baseUrl: "http://127.0.0.1:1",
      apiToken: API_TOKEN,
      organization: ORG,
      group: GROUP,
    });
    expect((await unreachable.ensureGroup())._unsafeUnwrapErr().kind).toBe("unreachable");
  });
});
