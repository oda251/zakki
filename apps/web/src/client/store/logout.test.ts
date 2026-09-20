import { describe, expect, test } from "bun:test";
import type { LogoutDeps } from "@zakki/web/client/store/logout.ts";
import { logoutSession } from "@zakki/web/client/store/logout.ts";

/**
 * issue #159: ログアウトのオーケストレーション（main.tsx の合成点から呼ばれる）。
 *
 * 順序は「サーバへ 1 往復（最善努力）→ ローカルの検証済みレプリカを消す → リロード」。
 * リロード後の起動フロー（resolveRemoteSession）が signed-out を出し直す。サーバ側
 * （apps/api の `POST /auth/logout`）と DB 削除はそれぞれ本物の統合テストがあるので、
 * ここは control-flow（順序・失敗時の進行）だけを注入した依存で確かめる。
 */
function makeDeps(
  opts: { logout?: "reject"; removeDb?: "reject" } = {},
): { calls: string[]; deps: LogoutDeps } {
  const calls: string[] = [];
  const deps: LogoutDeps = {
    logout: () => {
      calls.push("logout");
      return opts.logout === "reject"
        ? Promise.reject(new Error("network down"))
        : Promise.resolve();
    },
    removeDb: () => {
      calls.push("removeDb");
      return opts.removeDb === "reject"
        ? Promise.reject(new Error("db busy"))
        : Promise.resolve();
    },
    reload: () => {
      calls.push("reload");
    },
  };
  return { calls, deps };
}

describe("logoutSession", () => {
  test("L1: logout → removeDb → reload の順に進む", async () => {
    const { calls, deps } = makeDeps();
    await logoutSession(deps);
    expect(calls).toEqual(["logout", "removeDb", "reload"]);
  });

  test("L2: サーバへの 1 往復が失敗しても削除とリロードは進む（最善努力）", async () => {
    const { calls, deps } = makeDeps({ logout: "reject" });
    await logoutSession(deps);
    expect(calls).toEqual(["logout", "removeDb", "reload"]);
  });

  test("L3: ローカル DB の削除失敗は伝播する（削除せずにリロードしない）", async () => {
    const { calls, deps } = makeDeps({ removeDb: "reject" });
    // bun の rejects matcher は await できない型を返すため、明示的に捕まえて検証する
    let thrown: unknown = null;
    try {
      await logoutSession(deps);
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.message : "").toBe("db busy");
    // reload は呼ばれない（データを残したまま新セッションを引かない）
    expect(calls).toEqual(["logout", "removeDb"]);
  });
});