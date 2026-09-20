import { PasskeySettings } from "@zakki/web/client/layout/PasskeySettings.tsx";
import { useSettingsStore } from "@zakki/web/client/store/settings.ts";

/**
 * 設定パネル（モーダル, issue #159）。サイドバー下部の ⚙ ボタンとアカウントメニューの
 * 「設定」のどちらからでも開く。パスキー登録・アンロック（旧サイドバー下部, #104）は
 * ここへ移す。閉じ方はバックドロップクリック / ✕ / Escape の 3 つ。Escape は
 * document リスナーを使わず、開いた直後に autoFocus する ✕ ボタン（フォーカスが
 * モーダル内）の keydown が panel に発火する形で受ける（web client は即時発火の
 * イベントハンドラに寄せる, #52）。
 */
export function SettingsPanel() {
  const isOpen = useSettingsStore((s) => s.isOpen);
  const close = useSettingsStore((s) => s.close);

  if (!isOpen) return null;

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div className="settings-panel__header">
          <h2 className="settings-panel__title">設定</h2>
          <button
            type="button"
            className="settings-panel__close"
            aria-label="設定を閉じる"
            // 開いた直後はフォーカスをモーダル内の ✕ に置き、Escape をここで受ける
            autoFocus
            onClick={close}
          >
            ✕
          </button>
        </div>
        <div className="settings-panel__body">
          <PasskeySettings />
        </div>
      </div>
    </div>
  );
}