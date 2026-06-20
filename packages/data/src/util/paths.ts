import { homedir } from "node:os";
import { join } from "node:path";

/** XDG データディレクトリ（$XDG_DATA_HOME、なければ ~/.local/share） */
export function xdgDataHome(): string {
  return process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
}

/** XDG 設定ディレクトリ（$XDG_CONFIG_HOME、なければ ~/.config） */
export function xdgConfigHome(): string {
  return process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
}
