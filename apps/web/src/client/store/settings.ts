import { create } from "zustand";

/**
 * 設定パネル（モーダル）の開閉状態（issue #159）。アカウントメニューの「設定」も
 * サイドバー下部の ⚙ ボタンも、ここへ open() を投げるだけでパネルが開く
 * （App.tsx が {@link useSettingsStore.isOpen} を購読して SettingsPanel を描画する）。
 */
interface SettingsState {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
