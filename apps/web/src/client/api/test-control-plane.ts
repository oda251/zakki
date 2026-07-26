/**
 * テスト専用の in-process コントロールプレーン（issue #105）。
 *
 * ~/.references/policy/testing.md に従い、**実物の apps/api（Hono アプリ）をそのまま
 * プロセス内で動かす**。差し替えるのはローカルで再現できない依存だけ:
 * - Turso Platform API → #101 の fake（プロトコルレベル。実 API と同じ経路・JSON）
 * - 認証器 → #100 の WebCrypto ソフトウェア認証器（本物の ES256 署名）に PRF を足したもの
 *
 * メソッド単位の mock は使わない。登録・ログインは実際に HTTP（app.fetch）を通り、
 * 署名検証・challenge 消費・セッション JWT 発行も本物が動く。
 *
 * プロダクションコードからは import しない（db/test-passkey.ts と同じ分離）。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createApp } from "@zakki/api/app.ts";
import type { SoftAuthenticator } from "@zakki/api/auth/test-fixtures.ts";
import { createSoftAuthenticator } from "@zakki/api/auth/test-fixtures.ts";
import type { ControlDb } from "@zakki/api/db/client.ts";
import * as schema from "@zakki/api/db/schema.ts";
import { createTursoPlatform } from "@zakki/api/turso/platform.ts";
import { createFakePlatformApi } from "@zakki/api/turso/test-fixtures.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import type { CredentialsApi } from "@zakki/web/client/db/passkey.ts";

export const RP_ID = "zakki.test";
export const RP_ORIGIN = "https://zakki.test";
const ORGANIZATION = "zakki-org";
const GROUP = "zakki-group";
const PLATFORM_TOKEN = "platform-api-token";
const SESSION_SECRET = "test-session-secret";
/** apps/web/src/client/api → apps/api/drizzle（コントロールプレーン DB のマイグレーション） */
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "..", "api", "drizzle");

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function fromBase64Url(text: string): ArrayBuffer {
  return toArrayBuffer(new Uint8Array(Buffer.from(text, "base64url")));
}

function toBase64Url(src: BufferSource): string {
  const bytes = ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src);
  return Buffer.from(bytes).toString("base64url");
}

/** credential ごとの秘密シード + salt から 32 バイトを決定的に導出（実機 PRF の代役） */
function prfOutput(seed: Uint8Array, salt: BufferSource): Uint8Array<ArrayBuffer> {
  const saltBytes = ArrayBuffer.isView(salt)
    ? new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength)
    : new Uint8Array(salt);
  return Uint8Array.from(
    createHash("sha256").update(Buffer.from(seed)).update(Buffer.from(saltBytes)).digest(),
  );
}

/** PublicKeyCredential のうち control-plane.ts / passkey.ts が読む面だけを持つ形 */
interface FakeCredential extends Credential {
  readonly response: object;
  getClientExtensionResults: () => AuthenticationExtensionsClientOutputs;
}

export interface TestAuthenticator extends CredentialsApi {
  /** この認証器が PRF で返すシークレット（テストの期待値・wire 検査に使う） */
  readonly prfFor: (salt: BufferSource) => Uint8Array;
}

/**
 * ソフトウェア認証器（本物の ES256 署名）を `navigator.credentials` の形へ橋渡しする。
 * PRF は実機と同じく **create では有効化のみ**、値は get の
 * `clientExtensionResults.prf.results.first` で返す。
 */
export function testAuthenticator(
  authenticator: SoftAuthenticator,
  origin: string = RP_ORIGIN,
): TestAuthenticator {
  const seed = new Uint8Array(randomBytes(32));
  let counter = 0;

  const credential = (
    response: object,
    extensions: AuthenticationExtensionsClientOutputs,
  ): FakeCredential => ({
    id: authenticator.credentialId,
    type: "public-key",
    response,
    getClientExtensionResults: () => extensions,
  });

  return {
    prfFor: (salt) => prfOutput(seed, salt),

    create: async (options) => {
      const publicKey = options.publicKey;
      if (publicKey === undefined) throw new Error("publicKey が無い");
      const payload = await authenticator.attest({
        challenge: toBase64Url(publicKey.challenge),
        origin,
      });
      return credential(
        {
          clientDataJSON: fromBase64Url(payload.response.clientDataJSON),
          attestationObject: fromBase64Url(payload.response.attestationObject),
          getTransports: () => payload.response.transports,
        },
        publicKey.extensions?.prf === undefined ? {} : { prf: { enabled: true } },
      );
    },

    get: async (options) => {
      const publicKey = options.publicKey;
      if (publicKey === undefined) throw new Error("publicKey が無い");
      counter += 1;
      const payload = await authenticator.assert({
        challenge: toBase64Url(publicKey.challenge),
        origin,
        counter,
      });
      const salt = publicKey.extensions?.prf?.eval?.first;
      return credential(
        {
          clientDataJSON: fromBase64Url(payload.response.clientDataJSON),
          authenticatorData: fromBase64Url(payload.response.authenticatorData),
          signature: fromBase64Url(payload.response.signature),
          userHandle: null,
        },
        salt === undefined ? {} : { prf: { results: { first: prfOutput(seed, salt) } } },
      );
    },
  };
}

export interface TestControlPlane {
  /** apps/api への fetch（base URL は {@link TestControlPlane.baseUrl}） */
  readonly fetchFn: FetchLike;
  readonly baseUrl: string;
  /** api が受け取ったリクエスト（URL と本文）。wire の中身を検査するために全部残す */
  readonly requests: { url: string; body: string }[];
  /** 新しい認証器（= 新しいユーザの端末）を作る */
  readonly authenticator: () => Promise<TestAuthenticator>;
  readonly stop: () => Promise<void>;
}

/**
 * 実物の apps/api を組み立てて返す。コントロールプレーン DB は本物の libSQL
 * （一時ファイル）で、Platform API だけ fake を実サーバに載せて向ける。
 */
export async function createTestControlPlane(): Promise<TestControlPlane> {
  const fake = createFakePlatformApi({
    organization: ORGANIZATION,
    apiToken: PLATFORM_TOKEN,
    group: GROUP,
  });
  const platform = Bun.serve({ port: 0, fetch: fake.app.fetch });

  // libsql の :memory: はコネクション単位で独立するため一時ファイルを使う
  const path = join(mkdtempSync(join(tmpdir(), "zakki-cp-")), "control.sqlite");
  // 本番の ControlDb は Workers 向け HTTP クライアント（drizzle-orm/libsql/web）で、
  // テストは同じ schema の node 版を使う（プロトコル互換。db/client.ts の注記どおり）
  // oxlint-disable-next-line typescript/consistent-type-assertions -- node 版 → web 版の型の読み替え（apps/api のテストと同じ）
  const db = drizzle(createClient({ url: `file:${path}` }), { schema }) as unknown as ControlDb;
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const app = createApp({
    db,
    auth: { rpId: RP_ID, rpOrigin: RP_ORIGIN, sessionSecret: SESSION_SECRET },
    turso: createTursoPlatform({
      baseUrl: `http://127.0.0.1:${platform.port}`,
      apiToken: PLATFORM_TOKEN,
      organization: ORGANIZATION,
      group: GROUP,
    }),
  });

  const requests: { url: string; body: string }[] = [];
  const baseUrl = "https://control.test";

  return {
    baseUrl,
    requests,
    fetchFn: async (input, init) => {
      const request = new Request(input, init);
      // 本文は一度読むと消えるのでクローンから取る（観測のためだけ）
      requests.push({ url: input, body: await request.clone().text() });
      return app.fetch(request);
    },
    authenticator: async () => testAuthenticator(await createSoftAuthenticator(RP_ID)),
    stop: () => platform.stop(true),
  };
}
