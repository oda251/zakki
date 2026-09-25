import { create } from "zustand";
import { errorMessage } from "@zakki/core/util/error.ts";
import type { FilePasswordControls, FilePasswordStatus } from "@zakki/web/client/files/password.ts";

interface FilePasswordState {
  controls: FilePasswordControls | null;
  status: FilePasswordStatus;
  busy: boolean;
  message: string | null;
  connect: (controls: FilePasswordControls) => Promise<void>;
  refresh: () => Promise<void>;
  configure: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  change: (oldPassword: string, newPassword: string) => Promise<void>;
}

function describeError(err: unknown, secrets: readonly string[] = []): string {
  let message = errorMessage(err);
  for (const secret of secrets) {
    if (secret !== "") message = message.replaceAll(secret, "");
  }
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(message)
    ? message
    : "ファイルパスワードの操作に失敗しました";
}

function unreachable(value: never): never {
  throw new Error(String(value));
}

function statusMessage(status: FilePasswordStatus): string | null {
  switch (status) {
    case "unknown":
      return "ファイルパスワードの状態を確認できませんでした";
    case "unconfigured":
      return null;
    case "locked":
      return "パスワードが違います";
    case "unlocked":
      return null;
    default:
      return unreachable(status);
  }
}

export const useFilePasswordStore = create<FilePasswordState>((set, get) => ({
  controls: null,
  status: "unknown",
  busy: false,
  message: null,

  connect: async (controls) => {
    set({ controls, status: "unknown", busy: false, message: null });
    await get().refresh();
  },

  refresh: async () => {
    const controls = get().controls;
    if (controls === null || get().busy) return;
    set({ busy: true, message: null });
    try {
      const status = await controls.refresh();
      set({ status, busy: false, message: null });
    } catch (err: unknown) {
      set({ busy: false, message: describeError(err) });
    }
  },

  configure: async (password) => {
    const controls = get().controls;
    if (controls === null || get().busy) return;
    set({ busy: true, message: null });
    try {
      await controls.configure(password);
      set({
        status: await controls.status(),
        busy: false,
        message: "ファイルパスワードを設定しました",
      });
    } catch (err: unknown) {
      set({ busy: false, message: describeError(err, [password]) });
    }
  },

  unlock: async (password) => {
    const controls = get().controls;
    if (controls === null || get().busy) return;
    set({ busy: true, message: null });
    try {
      const status = await controls.unlock(password);
      set({
        status,
        busy: false,
        message:
          status === "unlocked" ? "ファイルパスワードをアンロックしました" : statusMessage(status),
      });
    } catch (err: unknown) {
      set({ busy: false, message: describeError(err, [password]) });
    }
  },

  change: async (oldPassword, newPassword) => {
    const controls = get().controls;
    if (controls === null || get().busy) return;
    set({ busy: true, message: null });
    try {
      const status = await controls.change(oldPassword, newPassword);
      set({
        status,
        busy: false,
        message:
          status === "unlocked"
            ? "ファイルパスワードを変更しました"
            : (statusMessage(status) ?? "パスワードを変更できませんでした"),
      });
    } catch (err: unknown) {
      set({ busy: false, message: describeError(err, [oldPassword, newPassword]) });
    }
  },
}));
