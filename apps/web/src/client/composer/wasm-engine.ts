import { ResultAsync } from "neverthrow";
import { useSyncExternalStore } from "react";
import type { EngineError, KanaKanjiEngine } from "@zakki/core/conversion/engine.ts";
import { loadAncoEngine } from "./wasm/load.ts";

/**
 * anco を wasm でクライアント実行する KanaKanjiEngine（issue #26）。サーバ変換を置き換える。
 * ロードは起動時に一度だけ。init 失敗（辞書読込・readiness probe 失敗含む）は
 * ブロッキングエラーとして扱い、フォールバックはしない（issue #26 の決定）。
 */
const toEngineError = (cause: unknown): EngineError => ({
  type: "engine-error",
  message: cause instanceof Error ? cause.message : String(cause),
  cause,
});

export async function createWasmEngine(): Promise<KanaKanjiEngine> {
  const calls = await loadAncoEngine();
  return {
    name: "wasm-anco",
    // 変換は wasm 内の同期処理（~15ms）。将来 Worker 化する場合もこの境界は不変。
    convert: (kana, leftContext) =>
      ResultAsync.fromPromise(
        Promise.resolve().then(() => calls.convert(kana, leftContext ?? "")),
        toEngineError,
      ),
    close: () => {},
  };
}

// --- 起動時に一度だけロードして ready 状態を共有する外部ストア ---
interface EngineState {
  readonly engine: KanaKanjiEngine | null;
  readonly error: string | null;
}

let state: EngineState = { engine: null, error: null };
let started = false;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const listener of listeners) listener();
};

function start(): void {
  if (started) return;
  started = true;
  void createWasmEngine()
    .then((engine) => {
      state = { engine, error: null };
    })
    .catch((cause: unknown) => {
      state = { engine: null, error: cause instanceof Error ? cause.message : String(cause) };
    })
    .then(emit);
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * wasm エンジンの ready 状態。engine=null かつ error=null はロード中、
 * error!=null は初期化失敗（ブロッキング）。
 */
export function useWasmEngine(): EngineState {
  return useSyncExternalStore(subscribe, () => state);
}
