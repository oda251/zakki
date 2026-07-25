import { usePasskeyStore } from "@zakki/web/client/store/passkey.ts";

/**
 * パスキー（WebAuthn PRF）操作の最小 UI（issue #104）。左メニュー下部に
 * 「ボタン + 状態表示」だけを置く。DEK は bootstrap のクロージャに閉じており、
 * この層は操作を呼ぶだけ（PRF 出力・DEK に触れない）。
 *
 * WebAuthn の呼び出しは **必ずクリックハンドラ（ユーザジェスチャ）から** 行う:
 * WebKit は起動直後の自動試行を `NotAllowedError` で拒むため、アンロックには
 * 「パスキーでアンロック」、登録の 2 段目には「続けて認証する」という
 * ジェスチャ起点の入口を用意する（出典:
 * https://webkit.org/blog/11312/meet-face-id-and-touch-id-for-the-web/ ）。
 */
export function PasskeySettings() {
  const controls = usePasskeyStore((s) => s.controls);
  const status = usePasskeyStore((s) => s.status);
  const message = usePasskeyStore((s) => s.message);
  const pendingCredentialId = usePasskeyStore((s) => s.pendingCredentialId);
  const enroll = usePasskeyStore((s) => s.enroll);
  const retrySave = usePasskeyStore((s) => s.retrySave);
  const unlock = usePasskeyStore((s) => s.unlock);

  if (controls === null) return null;
  if (!controls.available) {
    return <div className="sidebar__footer empty-note">この環境ではパスキーを利用できません</div>;
  }

  const running = status === "running";
  return (
    <div className="sidebar__footer">
      {controls.unlock !== null && (
        <button
          type="button"
          className="sidebar__action"
          disabled={running}
          onClick={() => void unlock()}
        >
          {running ? "認証中…" : "🔑 パスキーでアンロック"}
        </button>
      )}
      {pendingCredentialId !== null && controls.saveEnvelope !== null && (
        <button
          type="button"
          className="sidebar__action"
          disabled={running}
          onClick={() => void retrySave()}
        >
          {running ? "認証中…" : "🔑 続けて認証する"}
        </button>
      )}
      {pendingCredentialId === null && controls.createCredential !== null && (
        <button
          type="button"
          className="sidebar__action"
          disabled={running}
          onClick={() => void enroll()}
        >
          {running ? "登録中…" : controls.enrolled ? "🔑 パスキーを再登録" : "🔑 パスキーを追加"}
        </button>
      )}
      {controls.unlock === null && controls.createCredential === null && (
        <div className="empty-note">アンロック後にパスキーを登録できます</div>
      )}
      {message !== null && <div className="empty-note">{message}</div>}
    </div>
  );
}
