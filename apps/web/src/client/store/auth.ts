import { create } from "zustand";
import type { RemoteProviderOption } from "@zakki/web/client/api/control-plane.ts";

/**
 * OIDC ログイン UI の状態（docs/MULTIUSER.md「ログイン（OIDC）」）。main.tsx の合成点が
 * `resolveRemoteSession()` の結果を一度だけ渡す。signed-in・単一ユーザ構成
 * （`resolveRemoteSession` が null）のときは `connect` を呼ばないため、既定の
 * `{ kind: "hidden" }` のままになり、{@link import("@zakki/web/client/layout/LoginButton.tsx").LoginButton}
 * は何も表示しない。
 */
export type AuthUiState =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "signed-out";
      readonly providers: readonly RemoteProviderOption[];
      readonly error: string | null;
    };

interface AuthState {
  readonly ui: AuthUiState;
  /** main.tsx の合成点から一度呼ぶ（signed-out のときだけ） */
  readonly setSignedOut: (
    providers: readonly RemoteProviderOption[],
    error: string | null,
  ) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  ui: { kind: "hidden" },
  setSignedOut: (providers, error) => set({ ui: { kind: "signed-out", providers, error } }),
}));
