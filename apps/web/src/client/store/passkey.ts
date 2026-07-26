import { create } from "zustand";
import { errorMessage } from "@zakki/core/util/error.ts";
import { ApiRequestError } from "@zakki/web/client/api/client.ts";
import type { PasskeyControls } from "@zakki/web/client/db/bootstrap.ts";

/**
 * パスキー操作 UI の状態（issue #104）。bootstrap が返す {@link PasskeyControls}
 * （DEK を閉じ込めたクロージャ）を合成点（main.tsx）から受け取るだけで、
 * DEK・PRF 出力はこのストアにも UI にも渡らない。
 *
 * 登録が 2 段（作成 → 保存）なのは WebKit のユーザジェスチャ要求への対応:
 * 1 クリックで両方通れば完了し、2 度目の WebAuthn 呼び出しが弾かれた場合は
 * {@link PasskeyState.pendingCredentialId} を保持して「続けて認証する」から
 * 保存だけを別クリックでやり直せるようにする。
 */
interface PasskeyState {
  /** bootstrap 完了前は null（UI は何も出さない） */
  controls: PasskeyControls | null;
  status: "idle" | "running" | "done" | "error";
  message: string | null;
  /** 作成済みで封筒保存だけ残っている credentialId（Safari の 2 ジェスチャ対応） */
  pendingCredentialId: string | null;
  /** main.tsx の合成点から一度呼ぶ */
  connect: (controls: PasskeyControls) => void;
  /** パスキーを作成して封筒を保存する（クリックハンドラから呼ぶこと） */
  enroll: () => Promise<void>;
  /** 作成済みパスキーの封筒保存だけをやり直す（クリックハンドラから呼ぶこと） */
  retrySave: () => Promise<void>;
  /** passkey アンロックの再試行（クリックハンドラから呼ぶこと） */
  unlock: () => Promise<void>;
}

/**
 * 例外を UI 向けの日本語メッセージにする。サーバの内部文言（英語）は
 * ステータスから意味を引き直し、そのまま画面に出さない。
 */
function describeError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 409) {
      return "サーバの暗号セットアップが未完了です（先にパスフレーズを設定してください）";
    }
    if (err.status === 400) return "封筒の形式が不正なため保存できませんでした";
    return `サーバへの保存に失敗しました（HTTP ${err.status}）`;
  }
  // PasskeyError（未対応・キャンセル）は日本語メッセージを持つ
  return errorMessage(err);
}

export const usePasskeyStore = create<PasskeyState>((set, get) => ({
  controls: null,
  status: "idle",
  message: null,
  pendingCredentialId: null,

  connect: (controls) => {
    set({ controls, status: "idle", message: null, pendingCredentialId: null });
  },

  enroll: async () => {
    const controls = get().controls;
    if (controls === null || controls.createCredential === null) return;
    set({ status: "running", message: null });
    let credentialId: string;
    try {
      credentialId = await controls.createCredential();
    } catch (err: unknown) {
      set({ status: "error", message: describeError(err) });
      return;
    }
    // 作成は済んでいるので、保存に失敗しても credentialId を保持して再開できるようにする
    set({ pendingCredentialId: credentialId });
    await get().retrySave();
  },

  retrySave: async () => {
    const { controls, pendingCredentialId } = get();
    if (controls === null || controls.saveEnvelope === null || pendingCredentialId === null) return;
    set({ status: "running", message: null });
    try {
      await controls.saveEnvelope(pendingCredentialId);
      set({
        // 封筒はクレデンシャルごと（#120）なので、登録済み一覧にも足す（同じ id の
        // 再登録は上書きなので重複させない）
        controls: {
          ...controls,
          enrolled: true,
          credentialIds: controls.credentialIds.includes(pendingCredentialId)
            ? controls.credentialIds
            : [...controls.credentialIds, pendingCredentialId],
        },
        status: "done",
        message: "パスキーを登録しました。次回からは生体認証だけで開けます",
        pendingCredentialId: null,
      });
    } catch (err: unknown) {
      set({
        status: "error",
        message: `${describeError(err)}（「続けて認証する」でやり直せます）`,
      });
    }
  },

  unlock: async () => {
    const controls = get().controls;
    if (controls === null || controls.unlock === null) return;
    // 再入したまま replication が二重に張られないよう、状態側でも弾く
    // （UI の disabled だけに頼らない）
    if (get().status === "running") return;
    set({ status: "running", message: null });
    try {
      const next = await controls.unlock();
      set(
        next.unlocked
          ? { controls: next.passkey, status: "done", message: "パスキーでアンロックしました" }
          : {
              controls: next.passkey,
              status: "error",
              message: "パスキーでのアンロックに失敗しました（もう一度お試しください）",
            },
      );
    } catch (err: unknown) {
      // unlockWithPasskey は自前で null に畳むので、ここへ来るのは replication 開始や
      // FieldCrypto 生成が投げた場合。status を running のままにするとボタンが
      // すべて disabled で固まり、リロード以外に復帰手段が無くなる
      set({ status: "error", message: describeError(err) });
    }
  },
}));
