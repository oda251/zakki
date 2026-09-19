import { create } from "zustand";
import type { SignedOutSession } from "@zakki/web/client/api/control-plane.ts";

/**
 * OIDC ログイン UI の状態（docs/MULTIUSER.md「ログイン（OIDC）」）。main.tsx の合成点が
 * `resolveRemoteSession()` の signed-out 結果をそのまま一度だけ渡す。signed-in・単一ユーザ構成
 * では null のままで、LoginButton は何も表示しない。
 */
interface AuthState {
  readonly signedOut: SignedOutSession | null;
  readonly setSignedOut: (session: SignedOutSession) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  signedOut: null,
  setSignedOut: (session) => set({ signedOut: session }),
}));
