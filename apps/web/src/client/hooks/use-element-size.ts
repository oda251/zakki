import { useCallback, useRef, useSyncExternalStore } from "react";
import type { RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

const ZERO: ElementSize = { width: 0, height: 0 };

/**
 * 要素サイズの購読（レイアウト系）。ResizeObserver を useSyncExternalStore で
 * ラップし、useEffect + useState を使わない（issue #52）。
 * ref はマウント後（subscribe 時点）に解決されるため、初回スナップショットは 0。
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const size = useRef<ElementSize>(ZERO);
  const subscribe = useCallback(
    (notify: () => void) => {
      const el = ref.current;
      if (el === null) return () => {};
      const observer = new ResizeObserver(([entry]) => {
        if (entry !== undefined) {
          size.current = { width: entry.contentRect.width, height: entry.contentRect.height };
          notify();
        }
      });
      observer.observe(el);
      return () => observer.disconnect();
    },
    [ref],
  );
  return useSyncExternalStore(subscribe, () => size.current);
}
