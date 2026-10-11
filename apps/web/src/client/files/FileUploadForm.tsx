import { useMemo, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "@zakki/core/util/error.ts";
import {
  FILE_RETENTIONS,
  PERMANENT_MAX_BYTES,
  type FileRetention,
} from "@zakki/core/file/retention.ts";
import { docId, numId } from "@zakki/web/client/db/ids.ts";
import { graphNodeLabel, isFileExpired, retentionLabel } from "@zakki/web/client/files/display.ts";
import { selectNode } from "@zakki/web/client/router/navigate.ts";
import { useFilePasswordStore } from "@zakki/web/client/store/file-password.ts";
import { useFileStore } from "@zakki/web/client/store/files.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

const PERMANENT_ERROR =
  "10 MiB以上のファイルは「無期限」で保存できません。1日・7日・30日を選択してください";
const RETENTION_OPTIONS = FILE_RETENTIONS.map((value) => ({
  value,
  label: retentionLabel(value),
}));

interface FileUploadFormProps {
  readonly parentId: number;
}

function retentionFromValue(value: string): FileRetention | null {
  return RETENTION_OPTIONS.find((option) => option.value === value)?.value ?? null;
}

export function FileUploadForm({ parentId }: FileUploadFormProps) {
  const data = useGraphStore((s) => s.data);
  const files = useGraphStore((s) => s.files);
  const uploadActivity = useFileStore((s) => s.activity);
  const upload = useFileStore((s) => s.upload);
  const passwordStatus = useFilePasswordStore((s) => s.status);
  const passwordBusy = useFilePasswordStore((s) => s.busy);
  const configurePassword = useFilePasswordStore((s) => s.configure);
  const unlockPassword = useFilePasswordStore((s) => s.unlock);
  const refreshPassword = useFilePasswordStore((s) => s.refresh);

  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [retention, setRetention] = useState<FileRetention>("7d");
  const [encrypted, setEncrypted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = uploadActivity !== "idle" || passwordBusy;
  const permanentTooLarge = file !== null && file.size >= PERMANENT_MAX_BYTES;
  const permanentBlocked = permanentTooLarge && retention === "permanent";
  const blobChildren = useMemo(
    () =>
      (data?.nodes ?? [])
        .filter((node) => node.parentId === parentId && node.kind === "blob")
        .toSorted((a, b) => a.position - b.position || a.id - b.id),
    [data, parentId],
  );

  const updatePermanentError = (blocked: boolean): void => {
    if (blocked) {
      setError(PERMANENT_ERROR);
      return;
    }
    setError((current) => (current === PERMANENT_ERROR ? null : current));
  };

  const clearSensitiveFields = (): void => {
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
    setFile(null);
    setPassword("");
    setConfirmation("");
    setEncrypted(false);
    setRetention("7d");
    setError(null);
  };

  const prepareEncryption = async (): Promise<boolean> => {
    if (!encrypted) return true;

    const state = useFilePasswordStore.getState();
    if (state.status === "unknown") {
      setError("ファイルパスワードの状態を確認できません。再読み込みしてください");
      return false;
    }

    try {
      if (state.status === "unconfigured") {
        if (password === "") {
          setError("暗号化するにはファイルパスワードを設定してください");
          return false;
        }
        if (password !== confirmation) {
          setError("パスワードが一致しません");
          return false;
        }
        await configurePassword(password);
      } else if (state.status === "locked") {
        if (password === "") {
          setError("暗号化するにはファイルパスワードを入力してください");
          return false;
        }
        await unlockPassword(password);
      }

      const current = useFilePasswordStore.getState();
      const fek = current.controls?.fek();
      if (fek === null || fek === undefined) {
        setError(current.message ?? "暗号化パスワードをアンロックできませんでした");
        return false;
      }
      setPassword("");
      setConfirmation("");
      return true;
    } catch (cause: unknown) {
      setError(errorMessage(cause));
      return false;
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (file === null) {
      setError("ファイルを選択してください");
      return;
    }
    if (file.size === 0) {
      setError("ファイルが空です");
      return;
    }
    if (permanentBlocked) {
      setError(PERMANENT_ERROR);
      return;
    }

    setError(null);
    if (!(await prepareEncryption())) return;

    try {
      const uploaded = await upload({
        file,
        parentId: docId(parentId),
        retention,
        encrypted,
      });
      if (uploaded === null) {
        setError(
          useFileStore.getState().message ??
            "ファイルのアップロードに失敗しました。時間をおいて再試行してください",
        );
        return;
      }
      clearSensitiveFields();
      selectNode(numId(uploaded.chunk.id));
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  };

  const handleRefreshPassword = async (): Promise<void> => {
    setError(null);
    try {
      await refreshPassword();
      const state = useFilePasswordStore.getState();
      if (state.status === "unknown") {
        setError(state.message ?? "ファイルパスワードの状態を確認できませんでした");
      }
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  };

  return (
    <section className="file-upload" aria-labelledby="file-upload-heading">
      <h3 id="file-upload-heading" className="file-upload__heading">
        ファイル
      </h3>
      <button
        type="button"
        className="file-upload__toggle"
        aria-expanded={open}
        aria-controls="file-upload-form"
        onClick={() => setOpen((current) => !current)}
      >
        ファイルを追加
      </button>
      {open && (
        <form id="file-upload-form" className="file-upload__form" onSubmit={handleSubmit}>
          <label className="file-upload__field">
            <span>ファイル</span>
            <input
              ref={fileInputRef}
              className="file-upload__input"
              type="file"
              disabled={busy}
              onChange={(event) => {
                const next = event.currentTarget.files?.[0] ?? null;
                setFile(next);
                updatePermanentError(
                  next !== null && next.size >= PERMANENT_MAX_BYTES && retention === "permanent",
                );
              }}
            />
          </label>
          <label className="file-upload__field">
            <span>保存期間</span>
            <select
              className="file-upload__input"
              value={retention}
              disabled={busy}
              onChange={(event) => {
                const next = retentionFromValue(event.currentTarget.value);
                if (next === null) return;
                setRetention(next);
                updatePermanentError(next === "permanent" && permanentTooLarge);
              }}
            >
              {RETENTION_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.value === "permanent" && permanentTooLarge}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="file-upload__checkbox">
            <input
              type="checkbox"
              checked={encrypted}
              disabled={busy}
              onChange={(event) => {
                setEncrypted(event.currentTarget.checked);
                if (!event.currentTarget.checked) {
                  setPassword("");
                  setConfirmation("");
                }
                setError(null);
              }}
            />
            <span>暗号化してアップロード</span>
          </label>
          {encrypted && passwordStatus === "unconfigured" && (
            <>
              <label className="file-upload__field">
                <span>ファイルパスワード</span>
                <input
                  className="file-upload__input"
                  type="password"
                  value={password}
                  disabled={busy}
                  autoComplete="new-password"
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  required
                />
              </label>
              <label className="file-upload__field">
                <span>ファイルパスワード（確認）</span>
                <input
                  className="file-upload__input"
                  type="password"
                  value={confirmation}
                  disabled={busy}
                  autoComplete="new-password"
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                  required
                />
              </label>
            </>
          )}
          {encrypted && passwordStatus === "locked" && (
            <label className="file-upload__field">
              <span>ファイルパスワード</span>
              <input
                className="file-upload__input"
                type="password"
                value={password}
                disabled={busy}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.currentTarget.value)}
                required
              />
            </label>
          )}
          {encrypted && passwordStatus === "unknown" && (
            <div className="file-upload__notice">
              <span>ファイルパスワードの状態を確認できません。</span>
              <button
                type="button"
                className="file-upload__secondary"
                disabled={busy}
                onClick={() => void handleRefreshPassword()}
              >
                再読み込み
              </button>
            </div>
          )}
          {encrypted && passwordStatus === "unlocked" && (
            <div className="file-upload__notice">暗号化パスワードをアンロック済みです</div>
          )}
          <button type="submit" className="file-upload__submit" disabled={busy || permanentBlocked}>
            {uploadActivity === "uploading" ? "アップロード中…" : "追加"}
          </button>
          {error !== null && (
            <div className="file-upload__error" role="alert">
              {error}
            </div>
          )}
        </form>
      )}
      {blobChildren.length > 0 && (
        <div className="file-upload__list" aria-label="このバッファのファイル">
          {blobChildren.map((node) => {
            const fileDoc = node.fileId === null ? undefined : files.get(node.fileId);
            const expired = fileDoc !== undefined && isFileExpired(fileDoc, Date.now());
            return (
              <button
                key={node.id}
                type="button"
                className="file-upload__file"
                onClick={() => selectNode(node.id)}
              >
                <span>{graphNodeLabel(node, files)}</span>
                {expired && <span className="file-upload__expired">期限切れ</span>}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
