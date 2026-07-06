import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

/**
 * 環境変数の起動時スキーマ検証（issue #48）。
 *
 * 生の process.env を深層パッケージで参照せず、合成点（apps/tui/src/index.tsx /
 * apps/web/src/server/index.ts / CLI エントリ）が起動時に一度だけ `parseZakkiConfig` で
 * 検証し、型付きの `ZakkiConfig` を引数として注入する。
 *
 * 意味論は従来どおり: 未設定は undefined（各利用箇所の既定へフォールバック）、
 * フラグは "1" のみ有効、ポート既定は 3777。検証（ポートの数値・範囲チェック）が
 * 加わることだけが差分。
 */

/** フラグ環境変数: "1" のみ true（従来の `=== "1"` 判定を踏襲）。未設定は false */
const flag = v.pipe(
  v.optional(v.string(), ""),
  v.transform((value) => value === "1"),
);

/** ポート番号: 整数文字列のみ受け付け、1〜65535 に制限する */
const port = v.pipe(
  v.string(),
  v.regex(/^\d+$/, "1〜65535 の整数を指定してください"),
  v.transform((value) => Number(value)),
  v.minValue(1, "1〜65535 の整数を指定してください"),
  v.maxValue(65535, "1〜65535 の整数を指定してください"),
);

/** ZAKKI_WEB_PORT の既定値（apps/web のサーバと vite dev proxy が共有） */
export const DEFAULT_WEB_PORT = 3777;

/**
 * 環境変数スキーマ。キーは環境変数名そのもの（検証エラーで変数名を示すため）で、
 * 出力は camelCase の設定オブジェクトへ写す。未知のキーは無視する。
 */
const EnvSchema = v.pipe(
  v.object({
    ZAKKI_USER_ID: v.optional(v.string()),
    ZAKKI_TURSO_URL: v.optional(v.string()),
    ZAKKI_TURSO_TOKEN: v.optional(v.string()),
    ZAKKI_LLM_BASE_URL: v.optional(v.string()),
    ZAKKI_LLM_MODEL: v.optional(v.string()),
    ZAKKI_ANCO_PATH: v.optional(v.string()),
    ZAKKI_ZENZ_PATH: v.optional(v.string()),
    ZAKKI_VAULT_DIR: v.optional(v.string()),
    ZAKKI_NO_EMBEDDING: flag,
    ZAKKI_ENCRYPTION: flag,
    ZAKKI_WEB_PORT: v.optional(port),
    XDG_DATA_HOME: v.optional(v.string()),
    XDG_CONFIG_HOME: v.optional(v.string()),
  }),
  v.transform((env) => ({
    /** ZAKKI_USER_ID（identity の上書き） */
    userId: env.ZAKKI_USER_ID,
    /** ZAKKI_TURSO_URL（embedded replica の同期先） */
    tursoUrl: env.ZAKKI_TURSO_URL,
    /** ZAKKI_TURSO_TOKEN */
    tursoToken: env.ZAKKI_TURSO_TOKEN,
    /** ZAKKI_LLM_BASE_URL（OpenAI 互換エンドポイント。未設定なら自動検出） */
    llmBaseUrl: env.ZAKKI_LLM_BASE_URL,
    /** ZAKKI_LLM_MODEL */
    llmModel: env.ZAKKI_LLM_MODEL,
    /** ZAKKI_ANCO_PATH（anco バイナリの上書き） */
    ancoPath: env.ZAKKI_ANCO_PATH,
    /** ZAKKI_ZENZ_PATH（zenz GGUF の上書き） */
    zenzPath: env.ZAKKI_ZENZ_PATH,
    /** ZAKKI_VAULT_DIR（Obsidian エクスポート先の上書き） */
    vaultDir: env.ZAKKI_VAULT_DIR,
    /** ZAKKI_NO_EMBEDDING=1（embedding 無効化・完全決定的動作） */
    noEmbedding: env.ZAKKI_NO_EMBEDDING,
    /** ZAKKI_ENCRYPTION=1（E2E 暗号のオプトイン） */
    encryption: env.ZAKKI_ENCRYPTION,
    /** ZAKKI_WEB_PORT（既定 3777） */
    webPort: env.ZAKKI_WEB_PORT ?? DEFAULT_WEB_PORT,
    /** XDG_DATA_HOME（未設定なら利用側が ~/.local/share へフォールバック） */
    xdgDataHome: env.XDG_DATA_HOME,
    /** XDG_CONFIG_HOME（未設定なら利用側が ~/.config へフォールバック） */
    xdgConfigHome: env.XDG_CONFIG_HOME,
  })),
);

/** 起動時に検証済みの型付き設定。合成点から各層へ必要なフィールドだけ渡す */
export type ZakkiConfig = v.InferOutput<typeof EnvSchema>;

/**
 * 環境変数を検証して ZakkiConfig へ写す。失敗時はどの変数が不正かを含む
 * メッセージを返す（合成点はこれを表示して即終了する）。
 */
export function parseZakkiConfig(
  env: Record<string, string | undefined>,
): Result<ZakkiConfig, string> {
  const result = v.safeParse(EnvSchema, env);
  if (result.success) {
    return ok(result.output);
  }
  const details = result.issues
    .map((issue) => `${v.getDotPath(issue) ?? "(不明)"}: ${issue.message}`)
    .join("、");
  return err(`環境変数が不正です — ${details}`);
}
