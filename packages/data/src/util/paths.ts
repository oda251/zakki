import { homedir } from "node:os";
import { join } from "node:path";

// アプリ用サブディレクトリ名（APP_DIR）は util/app-dir.ts へ分離した（issue #29）。
// このモジュールは homedir（node:os）に依存するため、合成点だけが使う。

/**
 * XDG データディレクトリ。override は合成点が検証済み config から渡す
 * $XDG_DATA_HOME の値（未設定なら ~/.local/share へフォールバック）。
 */
export function xdgDataHome(override?: string): string {
  return override ?? join(homedir(), ".local", "share");
}

/**
 * XDG 設定ディレクトリ。override は合成点が検証済み config から渡す
 * $XDG_CONFIG_HOME の値（未設定なら ~/.config へフォールバック）。
 */
export function xdgConfigHome(override?: string): string {
  return override ?? join(homedir(), ".config");
}
