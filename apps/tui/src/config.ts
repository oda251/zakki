import { parseZakkiConfig, type ZakkiConfig } from "@zakki/core/config/env.ts";

/**
 * 合成点（TUI / CLI エントリ）共通の環境変数検証（issue #48）。
 * 失敗時は不正な変数名を含むメッセージを表示して即終了する。
 * process.env は各エントリファイルからのみ渡す（深層での直参照を禁止）。
 */
export function loadConfigOrExit(env: Record<string, string | undefined>): ZakkiConfig {
  return parseZakkiConfig(env).match(
    (config) => config,
    (message): never => {
      console.error(`zakki: ${message}`);
      process.exit(1);
    },
  );
}
