import { useState } from "react";
import { useAuthStore, type AccountInfo } from "@zakki/web/client/store/auth.ts";
import { useSettingsStore } from "@zakki/web/client/store/settings.ts";

/**
 * サイドバー下部のユーザーメニュー（issue #159 の続き）。単一のトリガーボタンで、
 * ログインの有無に関わらず 1 つだけ出る（docs/tmp/local-user-menu.md）。
 *
 * - ログイン中: 表示用メールと OIDC プロバイダ名（主 identity, docs/MULTIUSER.md。
 *   内部の accountId は出さない）。ログアウトは auth ストアの `logout()` を呼ぶだけ
 *   （実体は main.tsx が登録した handler = client.logout → db.remove → reload）
 * - 未ログイン: 「ローカルユーザ」。データはローカル（IndexedDB）のみに保持される
 *   （サーバ永続化の整理は #163）。メニューには設定とプロバイダ別のログインを出す
 * - 単一ユーザ構成（signedOut も account も null）: 「ローカルユーザ」+ 設定のみ
 *
 * 設定は共通の settings ストアへ open() を投げ、App が描く SettingsPanel モーダルを開く。
 * 外側クリックでの閉じ方は document リスナーを使わず、メニューの裏に敷く透過 backdrop
 * ボタンで受ける（web client は即時発火のイベントハンドラに寄せる, #52）。
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

export function UserMenu({ account }: { account: AccountInfo | null }) {
  const signedOut = useAuthStore((s) => s.signedOut);
  const logout = useAuthStore((s) => s.logout);
  const openSettings = useSettingsStore((s) => s.open);
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);

  return (
    <div className="user-menu">
      <button
        type="button"
        className="user-menu__trigger"
        aria-expanded={open}
        aria-label="ユーザーメニュー"
        onClick={() => setOpen((v) => !v)}
      >
        {account !== null ? (
          <>
            <span className="user-menu__name">{account.providerName} でログイン中</span>
            <span className="user-menu__email">{account.email ?? "メール未公開"}</span>
          </>
        ) : (
          <span className="user-menu__name">ローカルユーザ</span>
        )}
        <span className="user-menu__icon" aria-hidden="true">
          ⚙
        </span>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="user-menu__backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={close}
          />
          <div className="user-menu__popover" role="menu" aria-label="ユーザーメニュー">
            <button
              type="button"
              className="user-menu__item"
              role="menuitem"
              onClick={() => {
                openSettings();
                close();
              }}
            >
              ⚙ 設定
            </button>
            {account !== null ? (
              <button
                type="button"
                className="user-menu__item user-menu__item--danger"
                role="menuitem"
                onClick={logout}
              >
                ログアウト
              </button>
            ) : (
              (signedOut?.providers ?? []).map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className="user-menu__item"
                  role="menuitem"
                  onClick={() => window.location.assign(provider.loginUrl)}
                >
                  {provider.name} でログイン
                </button>
              ))
            )}
            {signedOut !== null && signedOut.error !== null && (
              <div className="user-menu__note">{describeError(signedOut.error)}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}