import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Observable } from "rxjs";

/**
 * Observable を React で購読する薄いフック（issue #44 / #52 で useSyncExternalStore 化）。
 * observable が null の間（DB 未接続等）は initial を返す。identity が変わると
 * 再購読し値を initial へ戻すため、呼び出し側は useMemo で観測対象を安定させること。
 */
export function useObservable<T>(observable: Observable<T> | null, initial: T): T {
  const state = useRef<{ source: Observable<T> | null; value: T }>({
    source: observable,
    value: initial,
  });
  if (state.current.source !== observable) {
    state.current = { source: observable, value: initial };
  }
  const subscribe = useCallback(
    (notify: () => void) => {
      if (observable === null) return () => {};
      const sub = observable.subscribe((v) => {
        state.current.value = v;
        notify();
      });
      return () => sub.unsubscribe();
    },
    [observable],
  );
  return useSyncExternalStore(subscribe, () => state.current.value);
}
