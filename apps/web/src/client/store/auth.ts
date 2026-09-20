import { create } from "zustand";
import type { SignedOutSession } from "@zakki/web/client/api/control-plane.ts";

/**
 * サイドバー下部で表示するアカウント情報（メール + OIDC プロバイダ, issue #159）。
 * `ControlPlaneSession.account` と `accountId` から main.tsx の合成点が作る。
 */
export interface AccountInfo {
  readonly email: string | null;
  readonly providerId: string;
  readonly providerName: string;
  readonly userId: string;
}

/**
 * OIDC ログイン UI の状態（docs/MULTIUSER.md「ログイン（OIDC）」）。main.tsx の合成点が
 * `resolveRemoteSession()` の結果を一度だけ渡す: signed-out は `signedOut`、signed-in は
 * `account`。単一ユーザ構成では両方 null のままで、UserMenu は「ローカルユーザ」を出す。
 * ログアウトは UI から何を呼ぶか（client.logout → db.remove → reload の実体）を
 * handler として登録し、`logout()` がそれを呼ぶ（issue #159 の合成点）。
 */
interface AuthState {
  readonly signedOut: SignedOutSession | null;
  readonly account: AccountInfo | null;
  readonly setSignedOut: (session: SignedOutSession) => void;
  readonly setSignedIn: (account: AccountInfo) => void;
  readonly setLogoutHandler: (handler: (() => void) | null) => void;
  readonly logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => {
  // handler は React に購読させる対象ではない（毎回 set すると再描画する）ので
  // ストア外のクロージャに持つ。setState の代わりに set を使うのは登録時だけ
  let logoutHandler: (() => void) | null = null;
  return {
    signedOut: null,
    account: null,
    setSignedOut: (session) => set({ signedOut: session }),
    setSignedIn: (account) => set({ account }),
    setLogoutHandler: (handler) => {
      logoutHandler = handler;
    },
    logout: () => {
      logoutHandler?.();
      set({ account: null });
    },
  };
});
