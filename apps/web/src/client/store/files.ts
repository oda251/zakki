import { create } from "zustand";
import type { FileRetention } from "@zakki/core/file/upload.ts";
import { errorMessage } from "@zakki/core/util/error.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import type { FileDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { removeChunkTree } from "@zakki/web/client/db/writes.ts";
import type { FilePasswordControls } from "@zakki/web/client/files/password.ts";
import type { FileLike, UploadedFile } from "@zakki/web/client/files/upload.ts";

type FileActivity = "idle" | "uploading" | "downloading" | "deleting";

type FileDependencies = {
  db: ZakkiDatabase;
  fetchFn: FetchLike;
  controls: FilePasswordControls;
};

interface FileState {
  db: ZakkiDatabase | null;
  fetchFn: FetchLike | null;
  controls: FilePasswordControls | null;
  activity: FileActivity;
  message: string | null;
  connect: (db: ZakkiDatabase, fetchFn: FetchLike, controls: FilePasswordControls) => void;
  upload: (options: {
    file: FileLike;
    parentId: string;
    retention: FileRetention;
    encrypted: boolean;
  }) => Promise<UploadedFile | null>;
  download: (file: FileDoc) => Promise<Uint8Array | null>;
  removeChunk: (id: string) => Promise<boolean>;
}

function dependencies(state: FileState): FileDependencies {
  if (state.db === null || state.fetchFn === null || state.controls === null) {
    throw new Error("ファイル機能が準備されていません");
  }
  return { db: state.db, fetchFn: state.fetchFn, controls: state.controls };
}

export const useFileStore = create<FileState>((set, get) => ({
  db: null,
  fetchFn: null,
  controls: null,
  activity: "idle",
  message: null,

  connect: (db, fetchFn, controls) => {
    set({ db, fetchFn, controls, activity: "idle", message: null });
  },

  upload: async ({ file, parentId, retention, encrypted }) => {
    set({ activity: "uploading", message: null });
    try {
      const { db, fetchFn, controls } = dependencies(get());
      const fek = encrypted ? controls.fek() : null;
      if (encrypted && fek === null) {
        throw new Error("暗号化にはファイルパスワードのアンロックが必要です");
      }
      const { uploadFile } = await import("@zakki/web/client/files/upload.ts");
      return await uploadFile({ db, file, parentId, retention, fek, fetchFn });
    } catch (error: unknown) {
      set({ message: errorMessage(error) });
      return null;
    } finally {
      set({ activity: "idle" });
    }
  },

  download: async (file) => {
    set({ activity: "downloading", message: null });
    try {
      const { fetchFn, controls } = dependencies(get());
      const fek = file.encryption === "password" ? controls.fek() : null;
      if (file.encryption === "password" && fek === null) {
        throw new Error("暗号化ファイルはパスワードのアンロックが必要です");
      }
      const { downloadFile } = await import("@zakki/web/client/files/upload.ts");
      return await downloadFile({ file, fek, fetchFn });
    } catch (error: unknown) {
      set({ message: errorMessage(error) });
      return null;
    } finally {
      set({ activity: "idle" });
    }
  },

  removeChunk: async (id) => {
    set({ activity: "deleting", message: null });
    try {
      const { db, fetchFn } = dependencies(get());
      await removeChunkTree(db, id, { fetchFn });
      return true;
    } catch (error: unknown) {
      set({ message: errorMessage(error) });
      return false;
    } finally {
      set({ activity: "idle" });
    }
  },
}));
