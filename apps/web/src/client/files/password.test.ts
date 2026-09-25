import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { createDb } from "@zakki/data/db/connect.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import {
  changeFilePassword,
  createFilePasswordControls,
  hasFilePassword,
  setFilePassword,
  unlockFek,
} from "./password.ts";
import { useFilePasswordStore } from "@zakki/web/client/store/file-password.ts";
import { createApp } from "@zakki/web/server/app.ts";

/**
 * issue #157 §5: ファイル暗号のパスワードはユーザごとに一律。封筒はサーバに
 * 置き、パスワード・FEK はクライアントのメモリだけに載る（サーバは開けない）。
 */
let db: Db;
let app: Hono;
let fetchFn: FetchLike;

/** テストを速く保つための最小 Argon2id パラメータ */
const params = { opsLimit: 1, memLimit: 8192 * 1024 };

beforeAll(async () => {
  await ready();
});

beforeEach(async () => {
  db = await createDb(":memory:");
  app = createApp({ db });
  fetchFn = async (input, init) => app.request(input, init);
});

/**
 * 失敗を **await して** 検証する。bun の型では `expect(...).rejects.toThrow()` が
 * void を返し await できない（passkey.test.ts と同一の規約）。
 */
async function expectRejects(promise: Promise<unknown>): Promise<void> {
  let error: unknown = null;
  try {
    await promise;
  } catch (err: unknown) {
    error = err;
  }
  expect(error).not.toBeNull();
}

describe("ファイルパスワード", () => {
  test("F7: 設定した後、同じパスワードで FEK が開く", async () => {
    expect(await hasFilePassword({ fetchFn })).toBe(false);
    const fek = await setFilePassword({ password: "ひみつ", fetchFn, params });
    expect(await hasFilePassword({ fetchFn })).toBe(true);
    expect(await unlockFek({ password: "ひみつ", fetchFn })).toEqual(fek);
  });

  test("F8: パスワード変更後も同じ FEK が開く（既存ファイルは再暗号化しない）", async () => {
    const fek = await setFilePassword({ password: "ふるい", fetchFn, params });
    await changeFilePassword({
      oldPassword: "ふるい",
      newPassword: "あたらしい",
      fetchFn,
      params,
    });

    expect(await unlockFek({ password: "あたらしい", fetchFn })).toEqual(fek);
    expect(await unlockFek({ password: "ふるい", fetchFn })).toBeNull();
  });

  test("F9: パスワード違いは null（例外を UI へ漏らさない）", async () => {
    await setFilePassword({ password: "ひみつ", fetchFn, params });
    expect(await unlockFek({ password: "ちがう", fetchFn })).toBeNull();
  });

  test("未設定の DB では unlockFek が null", async () => {
    expect(await unlockFek({ password: "なんでも", fetchFn })).toBeNull();
  });

  test("旧パスワードが違えば変更は失敗し、封筒は差し替わらない", async () => {
    const fek = await setFilePassword({ password: "ふるい", fetchFn, params });
    await expectRejects(
      changeFilePassword({
        oldPassword: "ちがう",
        newPassword: "あたらしい",
        fetchFn,
        params,
      }),
    );
    expect(await unlockFek({ password: "ふるい", fetchFn })).toEqual(fek);
  });
});

describe("createFilePasswordControls", () => {
  test("設定・変更・再読込を FEK 非永続の closure で扱う", async () => {
    const controls = createFilePasswordControls({ fetchFn, params });
    expect(await controls.refresh()).toBe("unconfigured");

    const fek = await controls.configure("ひみつ");
    expect(await controls.status()).toBe("unlocked");
    expect(controls.fek()).toEqual(fek);

    await controls.change("ひみつ", "あたらしい");
    expect(controls.fek()).toEqual(fek);
    controls.clear();
    expect(controls.fek()).toBeNull();
    expect(await controls.status()).toBe("unknown");
  });

  test("パスワード違いは locked のまま FEK を持たない", async () => {
    await setFilePassword({ password: "ひみつ", fetchFn, params });
    const controls = createFilePasswordControls({ fetchFn, params });

    expect(await controls.unlock("ちがう")).toBe("locked");
    expect(controls.fek()).toBeNull();
  });

  test("Zustand には FEK もパスワードも渡さない", async () => {
    const controls = createFilePasswordControls({ fetchFn, params });
    await useFilePasswordStore.getState().connect(controls);
    expect(useFilePasswordStore.getState().status).toBe("unconfigured");

    await useFilePasswordStore.getState().configure("supersecret");
    expect(useFilePasswordStore.getState().status).toBe("unlocked");
    expect(JSON.stringify(useFilePasswordStore.getState())).not.toContain("supersecret");
  });
});
