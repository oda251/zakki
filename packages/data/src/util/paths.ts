import { homedir } from "node:os";
import { join } from "node:path";

/**
 * XDG ディレクトリ配下に作るアプリ用サブディレクトリ名の SSOT（issue #56）。
 * 例: `<dataHome>/zakki/zakki.sqlite`（db/client.ts）、`<configHome>/zakki/keyfile`
 * （crypto/keyfile.ts）、`<configHome>/zakki/identity.json`（identity/local.ts）、
 * anco/zenz の既定パス（backend/anco/engine.ts）。
 */
export const APP_DIR = "zakki";

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
