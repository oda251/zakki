import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { Identity } from "@zakki/core/identity/types.ts";

/** 設定ファイル（identity.json）の許容スキーマ。いずれも任意。未知キーは無視 */
const IdentityFileSchema = v.object({
  userId: v.optional(v.string()),
  tursoUrl: v.optional(v.string()),
  tursoToken: v.optional(v.string()),
});

type IdentityFile = v.InferOutput<typeof IdentityFileSchema>;

/** 環境変数からの上書き値（合成点が検証済み config の該当フィールドを渡す） */
export interface IdentityOverrides {
  readonly userId?: string;
  readonly tursoUrl?: string;
  readonly tursoToken?: string;
}

/** 設定ファイルのパス（<configHome>/zakki/identity.json） */
export function identityConfigPath(configHome: string): string {
  return join(configHome, "zakki", "identity.json");
}

/**
 * 設定ファイルを読む。存在しない・壊れている場合は throw せず空オブジェクトを返す
 * （オフライン・初回起動を正常系として扱う）。フィールド型違いも壊れたファイルと
 * 同様に空扱いとし、as キャストで通さない（境界検証, issue #48）。
 * 秘匿情報はログに出さない。
 */
function readIdentityFile(path: string): IdentityFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = v.safeParse(IdentityFileSchema, parsed);
  return result.success ? result.output : {};
}

/**
 * ローカル環境から Identity を解決する（docs/RESEARCH.md §6）。
 * 優先順位は env（引数の上書き値）→ 設定ファイル → 既定。turso 認証情報が
 * 無ければローカル専用（userId="local"・url/token なし）を返し、完全オフラインで
 * 動作する。configHome は解決済みの XDG 設定ディレクトリ。
 */
export function resolveLocalIdentity(env: IdentityOverrides, configHome: string): Identity {
  const file = readIdentityFile(identityConfigPath(configHome));
  const tursoUrl = env.tursoUrl ?? file.tursoUrl;
  const tursoToken = env.tursoToken ?? file.tursoToken;
  const userId = env.userId ?? file.userId ?? "local";
  return { userId, tursoUrl, tursoToken };
}
