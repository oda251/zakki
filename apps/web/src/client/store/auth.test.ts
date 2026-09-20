import { beforeEach, describe, expect, test } from "bun:test";
import type { SignedOutSession } from "@zakki/web/client/api/control-plane.ts";
import { useAuthStore } from "@zakki/web/client/store/auth.ts";

/**
 * issue #159: サイドバー下部のアカウント表示とログアウト。
 * ログインの裏側（completeLogin / resolveRemoteSession）は control-plane.test.ts が
 * 本物で検証済みなので、ここではストアの関心（signed-in の account を保持する・
 * ログアウトで登録済みの handler を呼ぶ）だけを見る。
 */

const signedOut: SignedOutSession = {
  status: "signed-out",
  providers: [{ id: "google", name: "Google", loginUrl: "/auth/oidc/google/start" }],
  error: null,
};

beforeEach(() => {
  useAuthStore.setState({ signedOut: null, account: null });
});

describe("useAuthStore", () => {
  test("A1: setSignedIn が account を保持する", () => {
    useAuthStore.getState().setSignedIn({
      email: "me@example.com",
      providerId: "google",
      providerName: "Google",
      userId: "acc-1",
    });
    expect(useAuthStore.getState().account).toEqual({
      email: "me@example.com",
      providerId: "google",
      providerName: "Google",
      userId: "acc-1",
    });
  });

  test("A2: setSignedOut は従来どおり signedOut を保持する（signed-in とは別物）", () => {
    useAuthStore.getState().setSignedOut(signedOut);
    expect(useAuthStore.getState().signedOut).toEqual(signedOut);
    expect(useAuthStore.getState().account).toBeNull();
  });

  test("A3: logout は登録済み handler を呼び、account を消す", () => {
    let called = 0;
    useAuthStore.getState().setLogoutHandler(() => {
      called += 1;
    });
    useAuthStore.getState().setSignedIn({
      email: "me@example.com",
      providerId: "google",
      providerName: "Google",
      userId: "acc-1",
    });

    useAuthStore.getState().logout();

    expect(called).toBe(1);
    expect(useAuthStore.getState().account).toBeNull();
  });
});