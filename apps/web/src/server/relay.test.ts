import { beforeEach, describe, expect, test } from "bun:test";
import { generateDek } from "@zakki/core/crypto/dek.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import { addPassphraseEnvelope } from "@zakki/data/crypto/envelopes.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { Hono } from "hono";
import { composeRelayApp } from "@zakki/web/server/relay.ts";
import { parseRelayEnv, serviceBinding } from "@zakki/web/server/worker-env.ts";

/**
 * マルチユーザ**専用**の中継アプリ（issue #134）。
 *
 * Workers 配備はローカル DB を持たない。`bootstrapServer`（bun）との違いは
 * 「フォールバック先の DB が無い」ことなので、そこが期待どおりに効くかを縛る:
 * 認証できないリクエストは中継先が決まらず 401 になり、**単一ユーザ DB へ
 * 落ちない**。
 *
 * コントロールプレーンはプロトコルレベルの fake（`/auth/me` と `/me/db` を
 * 実物と同じ JSON で返す）に差し替える。ユーザ DB はローカル libSQL。
 * 実物の apps/api と繋いだ経路は client/api/control-plane.test.ts が通している。
 */

const CONTROL_PLANE_URL = "https://control.test";
const TOKEN = "session-jwt";
const DB_URL = "libsql://user-db.example.turso.io";

let userDb: Db;
let app: Hono;
let opened: number;

/** 実物と同じ経路・同じ JSON を返す fake コントロールプレーン */
function fakeControlPlane(input: string, init?: RequestInit): Promise<Response> {
  const authorized = new Headers(init?.headers).get("authorization") === `Bearer ${TOKEN}`;
  if (!authorized) return Promise.resolve(new Response("unauthorized", { status: 401 }));
  if (input.endsWith("/auth/me")) {
    return Promise.resolve(Response.json({ accountId: "acc-1" }));
  }
  if (input.endsWith("/me/db")) {
    return Promise.resolve(
      Response.json({
        dbUrl: DB_URL,
        token: "db-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

beforeEach(async () => {
  await ready();
  userDb = await createDb(":memory:");
  opened = 0;
  app = composeRelayApp({
    controlPlaneUrl: CONTROL_PLANE_URL,
    fetchFn: fakeControlPlane,
    openUserDb: (identity) => {
      opened += 1;
      expect(identity.tursoUrl).toBe(DB_URL);
      return Promise.resolve(userDb);
    },
  });
});

describe("composeRelayApp", () => {
  test("Authorization が無ければ 401（単一ユーザ DB へ落ちない）", async () => {
    const res = await app.request("/api/crypto/envelopes");

    expect(res.status).toBe(401);
    expect(opened).toBe(0);
  });

  test("セッションがあれば、そのアカウントの DB から封筒を配る", async () => {
    await addPassphraseEnvelope(userDb, generateDek(), "テスト用パスフレーズ");

    const res = await app.request("/api/crypto/envelopes", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { envelopes: { kind: string }[] };
    expect(body.envelopes.map((e) => e.kind)).toEqual(["passphrase"]);
    expect(opened).toBe(1);
  });

  test("知らないセッションは 401（中継先を解決できない）", async () => {
    const res = await app.request("/api/crypto/envelopes", {
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(res.status).toBe(401);
    expect(opened).toBe(0);
  });

  test("replication も認証が無ければ 401", async () => {
    const res = await app.request("/api/replication/chunks/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoint: null, limit: 10 }),
    });

    expect(res.status).toBe(401);
  });

  test("GET /api/config はコントロールプレーンの所在を返す（クライアントの構成選択）", async () => {
    const res = await app.request("/api/config");

    expect(await res.json()).toEqual({ controlPlaneUrl: CONTROL_PLANE_URL });
  });
});

describe("parseRelayEnv", () => {
  test("コントロールプレーン URL を読む", () => {
    const config = parseRelayEnv({
      ZAKKI_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    })._unsafeUnwrap();

    expect(config.controlPlaneUrl).toBe(CONTROL_PLANE_URL);
  });

  test("未設定なら起動失敗（Workers 版はマルチユーザ専用で、単一ユーザ構成が成立しない）", () => {
    expect(parseRelayEnv({})._unsafeUnwrapErr()).toContain("ZAKKI_CONTROL_PLANE_URL");
  });
});

describe("serviceBinding", () => {
  test("fetch を持つ binding を受け取る", () => {
    const fake = { fetch: () => Promise.resolve(new Response("ok")) };
    expect(serviceBinding({ CONTROL_PLANE: fake }, "CONTROL_PLANE")).toBe(fake);
  });

  test("binding が無い・形が違うなら null（呼び出し側が起動失敗にする）", () => {
    // binding 忘れは「静かに 401 を返し続ける」形で出るので、起動時に落とす必要がある
    expect(serviceBinding({}, "CONTROL_PLANE")).toBeNull();
    expect(serviceBinding({ CONTROL_PLANE: null }, "CONTROL_PLANE")).toBeNull();
    expect(serviceBinding({ CONTROL_PLANE: "https://example.test" }, "CONTROL_PLANE")).toBeNull();
    expect(serviceBinding({ CONTROL_PLANE: {} }, "CONTROL_PLANE")).toBeNull();
  });
});
