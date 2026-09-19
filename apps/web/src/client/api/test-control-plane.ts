/**
 * テスト専用の in-process コントロールプレーン（issue #105）。
 *
 * ~/.references/policy/testing.md に従い、**実物の apps/api（Hono アプリ）をそのまま
 * プロセス内で動かす**。差し替えるのはローカルで再現できない依存だけ:
 * - Turso Platform API → #101 の fake（プロトコルレベル。実 API と同じ経路・JSON）
 * - ID プロバイダ（Google）→ fake OIDC プロバイダ（apps/api/src/auth/test-oidc.ts。
 *   discovery・token エンドポイント・RS256 署名の id_token を HTTP で返す）
 *
 * メソッド単位の mock は使わない。ログインは実際に HTTP（app.fetch）で
 * start → コールバック → handoff を通り、state 消費・トークン交換・セッション JWT
 * 発行も本物が動く。
 *
 * プロダクションコードからは import しない（db/test-passkey.ts と同じ分離）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createApp } from "@zakki/api/app.ts";
import {
  callback,
  createTestGoogleProvider,
  startLogin,
  TEST_API_ORIGIN,
  TEST_APP_ORIGIN,
} from "@zakki/api/auth/test-login.ts";
import { createFakeIdp } from "@zakki/api/auth/test-oidc.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/core/turso/platform.ts";
import { createFakePlatformApi } from "@zakki/core/turso/test-fixtures.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";

export { TEST_APP_ORIGIN };

const ORGANIZATION = "zakki-org";
const GROUP = "zakki-group";
const PLATFORM_TOKEN = "platform-api-token";
const SESSION_SECRET = "test-session-secret";
/** apps/web/src/client/api → apps/api/drizzle（コントロールプレーン DB のマイグレーション） */
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "..", "api", "drizzle");

export interface TestControlPlane {
  /** apps/api への fetch（base URL は {@link TestControlPlane.baseUrl}） */
  readonly fetchFn: FetchLike;
  readonly baseUrl: string;
  /** api が受け取ったリクエスト（URL と本文）。wire の中身を検査するために全部残す */
  readonly requests: { url: string; body: string }[];
  /**
   * ブラウザが Google で同意してコールバックから SPA へ戻ってきた状態を作る。
   * 戻り値は SPA が受け取る URL の fragment（`#login=<code>` または `#login_error=...`）。
   * subject が同じなら同じアカウント（= 同じ Google アカウントで入り直した）になる。
   */
  readonly authorize: (subject: string) => Promise<string>;
  readonly stop: () => Promise<void>;
}

/**
 * 実物の apps/api を組み立てて返す。コントロールプレーン DB は本物の libSQL
 * （一時ファイル）で、Platform API だけ fake を実サーバに載せて向ける。
 */
export async function createTestControlPlane(): Promise<TestControlPlane> {
  // group を持たない組織から始める（本番と同条件）。group は apps/api の
  // プロビジョニングが ensureGroup で作る（issue #130）
  const fake = createFakePlatformApi({ organization: ORGANIZATION, apiToken: PLATFORM_TOKEN });
  const platform = Bun.serve({ port: 0, fetch: fake.app.fetch });
  const idp = await createFakeIdp();

  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  const path = join(mkdtempSync(join(tmpdir(), "zakki-cp-")), "control.sqlite");
  // 本番の ControlDb は Workers 向け HTTP クライアント（drizzle-orm/libsql/web）で、
  // テストは同じ schema の node 版を使う（プロトコル互換。db/client.ts の注記どおり）
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え（apps/api のテストと同じ）
  const db = drizzle(createClient({ url: `file:${path}` }), { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const app = createApp({
    db,
    auth: { appOrigin: TEST_APP_ORIGIN, sessionSecret: SESSION_SECRET },
    providers: [createTestGoogleProvider(idp)],
    turso: createTursoPlatform({
      baseUrl: `http://127.0.0.1:${platform.port}`,
      apiToken: PLATFORM_TOKEN,
      organization: ORGANIZATION,
      group: GROUP,
    }),
  });

  const requests: { url: string; body: string }[] = [];

  return {
    baseUrl: TEST_API_ORIGIN,
    requests,
    fetchFn: async (input, init) => {
      const request = new Request(input, init);
      // 本文は一度読むと消えるのでクローンから取る（観測のためだけ）
      requests.push({ url: input, body: await request.clone().text() });
      return app.fetch(request);
    },
    authorize: async (subject) => {
      const started = await startLogin(app);
      const res = await callback(app, idp, started, { subject, email: `${subject}@example.com` });
      return new URL(res.headers.get("location") ?? "").hash;
    },
    stop: () => platform.stop(true),
  };
}
