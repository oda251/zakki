import { useState } from "react";
import type { AccountInfo } from "@zakki/web/client/store/auth.ts";
import { useAuthStore } from "@zakki/web/client/store/auth.ts";
import { useSettingsStore } from "@zakki/web/client/store/settings.ts";

/**
 * サイドバー下部のアカウント表示 + メニュー（issue #159）。signed-in のときだけ
 * 左メニュー（展開時）のフッターに出る。表示するのは表示用のメールと OIDC
 * プロバイダ名（主 identity, docs/MULTIUSER.md）で、内部の accountId は出さない。
 *
 * メニューは「設定」と「ログアウト」の 2 項目。ログアウトは auth ストアの
 * `logout()` を呼ぶだけ（実体は main.tsx が登録した handler =
 * client.logout → db.remove → location.reload）。設定は共通の settings ストアへ
 * open() を投げ、App が描く SettingsPanel モーダルを開く。
 *
 * 外側クリックでの閉じ方は document リスナーを使わず、メニューの裏に敷く透過
 * backdrop ボタンで受ける（web client は即時発火のイベントハンドラに寄せる, #52）。
 */
export function AccountMenu({ account }: { account: AccountInfo }) {
  const logout = useAuthStore((s) => s.logout);
  const openSettings = useSettingsStore((s) => s.open);
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);

  return (
    <div className="account-menu">
      <button
        type="button"
        className="account-menu__trigger"
        aria-expanded={open}
        aria-label="アカウントメニュー"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="account-menu__name">{account.providerName} でログイン中</span>
        <span className="account-menu__email">{account.email ?? "メール未公開"}</span>
        <span className="account-menu__caret" aria-hidden="true">
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="account-menu__backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={close}
          />
          <div className="account-menu__popover" role="menu" aria-label="アカウントメニュー">
            <button
              type="button"
              className="account-menu__item"
              role="menuitem"
              onClick={() => {
                openSettings();
                close();
              }}
            >
              ⚙ 設定
            </button>
            <button
              type="button"
              className="account-menu__item account-menu__item--danger"
              role="menuitem"
              onClick={logout}
            >
              ログアウト
            </button>
          </div>
        </>
      )}
    </div>
  );
}