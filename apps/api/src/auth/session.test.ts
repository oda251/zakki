import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { decode, sign } from "hono/jwt";
import type { SessionEnv } from "@zakki/api/context.ts";
import { issueSession, requireSession, SESSION_TTL_SEC } from "@zakki/api/auth/session.ts";

/**
 * セッションの発行と検証（issue #100）。api-3（#101）が同じ `requireSession` を
 * 再利用するため、ルート経由ではなくミドルウェア単体で検証する
 * （~/.references/policy/testing.md: 再利用関数はユニットテスト）。
 * 期限切れ・alg すり替えは統合テストからは作りにくいのでここで押さえる。
 */

const SECRET = "unit-test-secret";
const NOW = 1_785_000_000_000;

/** requireSession を通した先で accountId を返すだけの最小アプリ */
function guarded() {
  const app = new Hono<SessionEnv>();
  app.use("*", requireSession(SECRET));
  app.get("/", (c) => c.json({ accountId: c.get("accountId") }));
  return app;
}

async function callWith(authorization?: string): Promise<Response> {
  return guarded().fetch(
    new Request("https://control.test/", {
      headers: authorization === undefined ? {} : { Authorization: authorization },
    }),
  );
}

/** base64url（テストでトークンを手組みするため） */
function b64url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("issueSession", () => {
  test("accountId を subject に、TTL 分の有効期限を持つトークンを発行する", async () => {
    const session = await issueSession("acc-1", SECRET, NOW);
    const issuedAt = Math.floor(NOW / 1000);
    expect(session.expiresAt).toBe(issuedAt + SESSION_TTL_SEC);
    expect(decode(session.token).payload).toMatchObject({
      sub: "acc-1",
      iat: issuedAt,
      exp: issuedAt + SESSION_TTL_SEC,
    });
  });

  test("鍵材料をトークンに載せない（accountId と時刻だけ）", async () => {
    const session = await issueSession("acc-1", SECRET, NOW);
    // トークンは Authorization ヘッダで平文の wire に出る。E2E を守るため
    // DEK・PRF 出力・封筒に類する claim が増えていないことを鍵の集合で固定する
    expect(Object.keys(decode(session.token).payload).toSorted()).toEqual(["exp", "iat", "sub"]);
  });
});

describe("requireSession", () => {
  test("有効なトークンなら accountId をコンテキストへ載せて通す", async () => {
    const { token } = await issueSession("acc-1", SECRET, Date.now());
    const res = await callWith(`Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: "acc-1" });
  });

  test("Authorization ヘッダが無ければ 401", async () => {
    expect((await callWith()).status).toBe(401);
  });

  test("Bearer 以外のスキームは 401", async () => {
    const { token } = await issueSession("acc-1", SECRET, Date.now());
    expect((await callWith(`Basic ${token}`)).status).toBe(401);
  });

  test("トークンが空の Bearer は 401", async () => {
    expect((await callWith("Bearer ")).status).toBe(401);
  });

  test("別の鍵で署名されたトークンは 401", async () => {
    const { token } = await issueSession("acc-1", "another-secret", Date.now());
    expect((await callWith(`Bearer ${token}`)).status).toBe(401);
  });

  test("期限切れのトークンは 401", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = await sign({ sub: "acc-1", iat: past - 10, exp: past }, SECRET, "HS256");
    expect((await callWith(`Bearer ${token}`)).status).toBe(401);
  });

  test("alg を none にすり替えた無署名トークンは 401（ヘッダの alg を信じない）", async () => {
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = b64url(JSON.stringify({ sub: "acc-1", exp }));
    expect((await callWith(`Bearer ${header}.${payload}.`)).status).toBe(401);
  });

  test("sub の無いトークンは 401（accountId を決められない）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ iat: now, exp: now + 3600 }, SECRET, "HS256");
    expect((await callWith(`Bearer ${token}`)).status).toBe(401);
  });
});
