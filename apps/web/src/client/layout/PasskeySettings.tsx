import { usePasskeyStore } from "@zakki/web/client/store/passkey.ts";

/**
 * パスキー（WebAuthn PRF）登録の最小 UI（issue #104）。左メニュー下部に
 * 「ボタン + 状態表示」だけを置く。DEK は bootstrap のクロージャに閉じており、
 * この層は enroll を呼ぶだけ（PRF 出力・DEK に触れない）。
 */
export function PasskeySettings() {
  const controls = usePasskeyStore((s) => s.controls);
  const status = usePasskeyStore((s) => s.status);
  const message = usePasskeyStore((s) => s.message);
  const enroll = usePasskeyStore((s) => s.enroll);

  if (controls === null) return null;
  if (!controls.available) {
    return <div className="empty-note">この環境ではパスキーを利用できません</div>;
  }
  if (controls.enroll === null) {
    return <div className="empty-note">アンロック後にパスキーを登録できます</div>;
  }

  return (
    <div className="sidebar__footer">
      <button
        type="button"
        className="session-tag"
        disabled={status === "running"}
        onClick={() => void enroll()}
      >
        {status === "running"
          ? "登録中…"
          : controls.enrolled
            ? "🔑パスキーを再登録"
            : "🔑パスキーを追加"}
      </button>
      {message !== null && <div className="empty-note">{message}</div>}
    </div>
  );
}
