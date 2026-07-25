import { beforeEach, describe, expect, test } from "bun:test";
import { ApiRequestError } from "@zakki/web/client/api/client.ts";
import type { PasskeyControls } from "@zakki/web/client/db/bootstrap.ts";
import { PasskeyError } from "@zakki/web/client/db/passkey.ts";
import { usePasskeyStore } from "@zakki/web/client/store/passkey.ts";

/**
 * issue #104: パスキー UI の状態遷移。bootstrap の {@link PasskeyControls} は
 * 内部コード（passkey.test.ts / bootstrap.test.ts で本物を検証済み）なので、
 * ここでは UI 側の関心（失敗メッセージの日本語化・2 段登録の再開・
 * ジェスチャ再アンロック後の状態差し替え）だけをスタブで確かめる。
 */
const base: PasskeyControls = {
  available: true,
  enrolled: false,
  createCredential: () => Promise.resolve("cred-1"),
  saveEnvelope: () => Promise.resolve(),
  unlock: null,
};

beforeEach(() => {
  usePasskeyStore.setState({
    controls: null,
    status: "idle",
    message: null,
    pendingCredentialId: null,
  });
});

describe("usePasskeyStore.enroll", () => {
  test("S1: 作成 → 保存が通れば登録済みになり、保留は残らない", async () => {
    usePasskeyStore.getState().connect(base);
    await usePasskeyStore.getState().enroll();
    const state = usePasskeyStore.getState();
    expect(state.status).toBe("done");
    expect(state.controls?.enrolled).toBe(true);
    expect(state.pendingCredentialId).toBeNull();
  });

  test("S2: 2 段目（PRF 評価）が弾かれたら credentialId を保留し、retrySave で完了する", async () => {
    let fail = true;
    usePasskeyStore.getState().connect({
      ...base,
      saveEnvelope: () =>
        fail ? Promise.reject(new PasskeyError("認証がキャンセルされました")) : Promise.resolve(),
    });
    await usePasskeyStore.getState().enroll();
    expect(usePasskeyStore.getState().status).toBe("error");
    // 作成済み credential は捨てずに保持する（Safari の別ジェスチャ再開用）
    expect(usePasskeyStore.getState().pendingCredentialId).toBe("cred-1");
    expect(usePasskeyStore.getState().message).toContain("続けて認証する");

    fail = false;
    await usePasskeyStore.getState().retrySave();
    expect(usePasskeyStore.getState().status).toBe("done");
    expect(usePasskeyStore.getState().pendingCredentialId).toBeNull();
  });

  test("S3: サーバの内部文言（英語）ではなく日本語のメッセージを出す", async () => {
    usePasskeyStore.getState().connect({
      ...base,
      saveEnvelope: () => Promise.reject(new ApiRequestError(409, "crypto not provisioned")),
    });
    await usePasskeyStore.getState().enroll();
    const message = usePasskeyStore.getState().message ?? "";
    expect(message).not.toContain("crypto not provisioned");
    expect(message).toContain("暗号セットアップ");

    usePasskeyStore.getState().connect({
      ...base,
      saveEnvelope: () => Promise.reject(new ApiRequestError(500, "db-error")),
    });
    await usePasskeyStore.getState().enroll();
    expect(usePasskeyStore.getState().message ?? "").toContain("HTTP 500");
  });
});

describe("usePasskeyStore.unlock", () => {
  test("S4: 再試行が成功したら新しい controls に差し替える（登録操作が使えるようになる）", async () => {
    const unlockedControls: PasskeyControls = { ...base, enrolled: true, unlock: null };
    const locked: PasskeyControls = {
      ...base,
      enrolled: true,
      createCredential: null,
      saveEnvelope: null,
      unlock: () => Promise.resolve({ unlocked: true, passkey: unlockedControls }),
    };
    usePasskeyStore.getState().connect(locked);
    await usePasskeyStore.getState().unlock();
    expect(usePasskeyStore.getState().status).toBe("done");
    expect(usePasskeyStore.getState().controls?.createCredential).not.toBeNull();
  });

  test("S5: 再試行が失敗したら再度押せる状態のまま日本語で知らせる", async () => {
    const locked: PasskeyControls = {
      ...base,
      enrolled: true,
      createCredential: null,
      saveEnvelope: null,
      unlock: () => Promise.resolve({ unlocked: false, passkey: locked }),
    };
    usePasskeyStore.getState().connect(locked);
    await usePasskeyStore.getState().unlock();
    expect(usePasskeyStore.getState().status).toBe("error");
    expect(usePasskeyStore.getState().message).toContain("パスキー");
    expect(usePasskeyStore.getState().controls?.unlock).not.toBeNull();
  });

  test("S6: unlock が throw しても running で固まらず、再度押せる", async () => {
    // replication 開始や FieldCrypto 生成が投げるケース。running のままだと
    // ボタンがすべて disabled になりリロード以外に復帰手段が無くなる
    const locked: PasskeyControls = {
      ...base,
      enrolled: true,
      createCredential: null,
      saveEnvelope: null,
      unlock: () => Promise.reject(new Error("replication 開始に失敗")),
    };
    usePasskeyStore.getState().connect(locked);
    await usePasskeyStore.getState().unlock();
    expect(usePasskeyStore.getState().status).toBe("error");
    expect(usePasskeyStore.getState().message).toContain("replication 開始に失敗");
    expect(usePasskeyStore.getState().controls?.unlock).not.toBeNull();
  });
});
