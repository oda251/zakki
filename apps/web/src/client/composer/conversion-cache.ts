import { useSyncExternalStore } from "react";
import { api } from "@zakki/web/client/api/client.ts";

/**
 * サーバ変換（anco）の付随キャッシュのシード（issue #52 で fetch-on-mount を撤去）。
 * 初回購読で一度だけ取得する外部ストア。失敗しても空 Map で入力を続行できる
 * （キャッシュはヒント）。null = ロード中。#26 で anco ごとクライアントへ移る予定。
 */
let cache: ReadonlyMap<string, string> | null = null;
let started = false;
const listeners = new Set<() => void>();

function start(): void {
  if (started) return;
  started = true;
  void api
    .conversionState()
    .then((state) => {
      cache = new Map(Object.entries(state.cache));
    })
    .catch(() => {
      cache = new Map();
    })
    .then(() => {
      for (const listener of listeners) listener();
    });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 変換キャッシュのシード（ロード完了まで null） */
export function useConversionCache(): ReadonlyMap<string, string> | null {
  return useSyncExternalStore(subscribe, () => cache);
}
