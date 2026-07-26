import { describe, expect, test } from "bun:test";
import { isConnectionExpiring, remoteIdentity } from "./remote.ts";

const connection = {
  accountId: "acc-1",
  dbUrl: "libsql://zakki-acc-1-org.turso.io",
  token: "db-token",
  expiresAt: 2_000,
};

describe("remoteIdentity", () => {
  test("コントロールプレーンの接続情報を Identity の形へ写す", () => {
    const identity = remoteIdentity(connection);
    expect(identity.userId).toBe("acc-1");
    expect(identity.tursoUrl).toBe("libsql://zakki-acc-1-org.turso.io");
    expect(identity.tursoToken).toBe("db-token");
  });

  test("鍵材料（encKey）は載せない — 復号鍵はコントロールプレーン経路に存在しない", () => {
    expect(remoteIdentity(connection).encKey).toBeUndefined();
  });
});

describe("isConnectionExpiring", () => {
  test("十分に先なら false", () => {
    expect(isConnectionExpiring(connection, 1_000)).toBe(false);
  });

  test("残りが skew 未満なら true（先回りで取り直す）", () => {
    expect(isConnectionExpiring(connection, 1_950)).toBe(true);
  });

  test("失効済みは true", () => {
    expect(isConnectionExpiring(connection, 2_500)).toBe(true);
  });

  test("skew は呼び出し側が指定できる", () => {
    expect(isConnectionExpiring(connection, 1_950, 10)).toBe(false);
  });
});
