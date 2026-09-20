import { useAuthStore } from "@zakki/web/client/store/auth.ts";

/**
 * OIDC ログイン導線（docs/MULTIUSER.md「ログイン（OIDC）」）。未ログイン（多人数構成で
 * `resolveRemoteSession` が signed-out を返した）ときだけ、プロバイダごとの
 * ログインボタンを出す。signed-in・単一ユーザ構成では {@link useAuthStore} が
 * null のままなので何も描画しない。
 *
 * 押すと `window.location.assign` で開始 URL（`${base}/auth/oidc/:id/start`）へ
 * 遷移するだけ。同意後のコールバック・handoff 交換は control-plane.ts /
 * main.tsx（次回起動時の `resolveRemoteSession`）が担う。
 */
/** 未知の理由（サーバが将来足す種別）は provider 用の汎用メッセージに畳む */
function describeError(reason: string): string {
  switch (reason) {
    case "denied":
      return "ログインをキャンセルしました";
    case "state":
      return "ログインの有効期限が切れました。もう一度お試しください";
    case "exchange":
      return "ログインに失敗しました。もう一度お試しください";
    case "provider":
    default:
      return "ログインに失敗しました（プロバイダとの通信エラー）";
  }
}

export function LoginButton() {
  const signedOut = useAuthStore((s) => s.signedOut);

  if (signedOut === null) return null;

  return (
    <>
      {signedOut.providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className="sidebar__action"
          onClick={() => window.location.assign(provider.loginUrl)}
        >
          {provider.name} でログイン
        </button>
      ))}
      {signedOut.error !== null && (
        <div className="empty-note">{describeError(signedOut.error)}</div>
      )}
    </>
  );
}
