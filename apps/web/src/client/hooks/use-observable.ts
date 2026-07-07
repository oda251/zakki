import { useEffect, useState } from "react";
import type { Observable } from "rxjs";

/**
 * Observable を React で購読する薄いフック（issue #44）: 初期値 + アンマウント時の購読解除。
 * observable が null の間（DB 未接続等）は initial を返す。identity が変わると再購読する
 * ため、呼び出し側は useMemo で観測対象を安定させること。
 */
export function useObservable<T>(observable: Observable<T> | null, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (observable === null) return undefined;
    const sub = observable.subscribe((v) => setValue(v));
    return () => sub.unsubscribe();
  }, [observable]);
  return value;
}
