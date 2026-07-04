import { ResultAsync } from "neverthrow";
import type { EngineError, KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import { api } from "@zakki/web/client/api/client.ts";

const toEngineError = (cause: unknown): EngineError => ({
  type: "engine-error",
  message: cause instanceof Error ? cause.message : String(cause),
  cause,
});

/**
 * サーバの anco を叩く KanaKanjiEngine 実装（docs/COMPOSER.md の変換ルート）。
 * 既存の ConversionPipeline にそのまま注入する。将来 wasm 化しても
 * このインターフェースの差し替えだけで済む。
 */
export const remoteEngine: KanaKanjiEngine = {
  name: "remote",
  convert: (kana, leftContext) =>
    ResultAsync.fromPromise(
      api.convert(kana, leftContext).then((r) => r.candidates),
      toEngineError,
    ),
  close: () => {},
};
