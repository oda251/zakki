import { create } from "zustand";
import { errorMessage } from "@zakki/core/util/error.ts";
import type { PasskeyControls } from "@zakki/web/client/db/bootstrap.ts";

/**
 * パスキー登録 UI の状態（issue #104）。bootstrap が返す {@link PasskeyControls}
 * （DEK を閉じ込めたクロージャ）を合成点（main.tsx）から受け取るだけで、
 * DEK・PRF 出力はこのストアにも UI にも渡らない。
 */
interface PasskeyState {
  /** bootstrap 完了前は null（UI は何も出さない） */
  controls: PasskeyControls | null;
  status: "idle" | "running" | "done" | "error";
  message: string | null;
  /** main.tsx の合成点から一度呼ぶ */
  connect: (controls: PasskeyControls) => void;
  enroll: () => Promise<void>;
}

export const usePasskeyStore = create<PasskeyState>((set, get) => ({
  controls: null,
  status: "idle",
  message: null,

  connect: (controls) => {
    set({ controls, status: "idle", message: null });
  },

  enroll: async () => {
    const controls = get().controls;
    if (controls?.enroll === undefined || controls.enroll === null) return;
    set({ status: "running", message: null });
    try {
      await controls.enroll();
      set({
        controls: { ...controls, enrolled: true },
        status: "done",
        message: "パスキーを登録しました。次回からは生体認証だけで開けます",
      });
    } catch (err: unknown) {
      // 失敗理由（未対応・キャンセル）のみ表示する。秘密は含まれない
      set({ status: "error", message: errorMessage(err) });
    }
  },
}));
