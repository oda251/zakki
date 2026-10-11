import { useState, type FormEvent } from "react";
import { useFilePasswordStore } from "@zakki/web/client/store/file-password.ts";

export function FilePasswordSettings() {
  const controls = useFilePasswordStore((s) => s.controls);
  const status = useFilePasswordStore((s) => s.status);
  const busy = useFilePasswordStore((s) => s.busy);
  const message = useFilePasswordStore((s) => s.message);
  const refresh = useFilePasswordStore((s) => s.refresh);
  const configure = useFilePasswordStore((s) => s.configure);
  const unlock = useFilePasswordStore((s) => s.unlock);
  const change = useFilePasswordStore((s) => s.change);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  if (controls === null) return null;

  const clearPasswordFields = (): void => {
    setPassword("");
    setConfirmation("");
  };

  const validateConfirmation = (value: string, valueConfirmation: string): boolean => {
    if (value === "") {
      setValidationMessage("パスワードを入力してください");
      return false;
    }
    if (value !== valueConfirmation) {
      setValidationMessage("パスワードが一致しません");
      return false;
    }
    setValidationMessage(null);
    return true;
  };

  const handleConfigure = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!validateConfirmation(password, confirmation)) return;
    await configure(password);
    clearPasswordFields();
  };

  const handleUnlock = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password === "") {
      setValidationMessage("パスワードを入力してください");
      return;
    }
    setValidationMessage(null);
    await unlock(password);
    clearPasswordFields();
  };

  const handleChange = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (oldPassword === "") {
      setValidationMessage("現在のパスワードを入力してください");
      return;
    }
    if (!validateConfirmation(newPassword, newPasswordConfirmation)) return;
    await change(oldPassword, newPassword);
    setOldPassword("");
    setNewPassword("");
    setNewPasswordConfirmation("");
  };

  const notice = validationMessage ?? message;
  const disabled = busy;

  return (
    <section className="file-password-settings" aria-labelledby="file-password-settings-title">
      <h3 id="file-password-settings-title" className="file-password-settings__title">
        ファイルパスワード
      </h3>
      {status === "unknown" && (
        <>
          <div className="empty-note">{busy ? "状態を確認中…" : "状態を確認できませんでした"}</div>
          {!busy && (
            <button type="button" className="sidebar__action" onClick={() => void refresh()}>
              再読み込み
            </button>
          )}
        </>
      )}
      {status === "unconfigured" && (
        <>
          <div className="empty-note">未設定です。設定するとファイルを暗号化できます。</div>
          <form className="file-password-form" onSubmit={handleConfigure}>
            <label className="file-password-field">
              <span>新しいパスワード</span>
              <input
                className="sidebar__input"
                type="password"
                value={password}
                disabled={disabled}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label className="file-password-field">
              <span>パスワード（確認）</span>
              <input
                className="sidebar__input"
                type="password"
                value={confirmation}
                disabled={disabled}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <button type="submit" className="sidebar__action" disabled={disabled}>
              {busy ? "設定中…" : "パスワードを設定"}
            </button>
          </form>
        </>
      )}
      {status === "locked" && (
        <>
          <div className="empty-note">暗号化済みファイルを開くにはパスワードが必要です。</div>
          <form className="file-password-form" onSubmit={handleUnlock}>
            <label className="file-password-field">
              <span>パスワード</span>
              <input
                className="sidebar__input"
                type="password"
                value={password}
                disabled={disabled}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="sidebar__action" disabled={disabled}>
              {busy ? "確認中…" : "アンロック"}
            </button>
          </form>
        </>
      )}
      {status === "unlocked" && (
        <>
          <div className="empty-note">ファイルパスワードが設定済みです。</div>
          <form className="file-password-form" onSubmit={handleChange}>
            <label className="file-password-field">
              <span>現在のパスワード</span>
              <input
                className="sidebar__input"
                type="password"
                value={oldPassword}
                disabled={disabled}
                onChange={(e) => setOldPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label className="file-password-field">
              <span>新しいパスワード</span>
              <input
                className="sidebar__input"
                type="password"
                value={newPassword}
                disabled={disabled}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label className="file-password-field">
              <span>新しいパスワード（確認）</span>
              <input
                className="sidebar__input"
                type="password"
                value={newPasswordConfirmation}
                disabled={disabled}
                onChange={(e) => setNewPasswordConfirmation(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <button type="submit" className="sidebar__action" disabled={disabled}>
              {busy ? "変更中…" : "パスワードを変更"}
            </button>
          </form>
        </>
      )}
      {notice !== null && <div className="empty-note">{notice}</div>}
    </section>
  );
}
