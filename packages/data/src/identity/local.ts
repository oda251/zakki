import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Identity } from "@zakki/core/identity/types.ts";
import { xdgConfigHome } from "@zakki/data/util/paths.ts";

/** 設定ファイル（identity.json）の許容スキーマ。いずれも任意 */
interface IdentityFile {
  userId?: string;
  tursoUrl?: string;
  tursoToken?: string;
}

/** 設定ファイルのパス（$XDG_CONFIG_HOME/zakki/identity.json） */
export function identityConfigPath(): string {
  return join(xdgConfigHome(), "zakki", "identity.json");
}

/**
 * 設定ファイルを読む。存在しない・壊れている場合は throw せず空オブジェクトを返す
 * （オフライン・初回起動を正常系として扱う）。秘匿情報はログに出さない。
 */
function readIdentityFile(path: string): IdentityFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as IdentityFile) : {};
  } catch {
    return {};
  }
}

/**
 * ローカル環境から Identity を解決する（docs/RESEARCH.md §6）。
 * 優先順位は env → 設定ファイル → 既定。turso 認証情報が無ければローカル専用
 * （userId="local"・url/token なし）を返し、完全オフラインで動作する。
 */
export function resolveLocalIdentity(): Identity {
  const file = readIdentityFile(identityConfigPath());
  const tursoUrl = process.env["ZAKKI_TURSO_URL"] ?? file.tursoUrl;
  const tursoToken = process.env["ZAKKI_TURSO_TOKEN"] ?? file.tursoToken;
  const userId = process.env["ZAKKI_USER_ID"] ?? file.userId ?? "local";
  return { userId, tursoUrl, tursoToken };
}
