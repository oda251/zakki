/**
 * ログアウトのオーケストレーション（issue #159）。main.tsx の合成点が
 * `client.logout()` / `db.remove()` / `location.reload()` を deps として渡す。
 *
 * 順序は「サーバへ 1 往復（最善努力）→ ローカルの検証済みレプリカを消す → リロード」。
 * サーバ側の失敗は無視して進む（リロード後の起動フローが signed-out を出し直す）が、
 * ローカル DB の削除に失敗したらリロードしない（データを残したまま新セッションを
 * 引いて、削除分のデータを失わないようにする）。
 */
export interface LogoutDeps {
  readonly logout: () => Promise<void>;
  readonly removeDb: () => Promise<void>;
  readonly reload: () => void;
}

export async function logoutSession(deps: LogoutDeps): Promise<void> {
  await deps.logout().catch(() => {});
  await deps.removeDb();
  deps.reload();
}