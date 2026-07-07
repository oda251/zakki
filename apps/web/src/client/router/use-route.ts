import { useMemo, useSyncExternalStore } from "react";
import { currentHref, subscribeHref } from "@zakki/web/client/router/history.ts";
import { drillIdOf, parseRoute, type Route } from "@zakki/web/client/router/route.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";

/** 現在の URL（pathname+search）を購読する。popstate + 自前ナビゲーションで更新 */
function useHref(): string {
  return useSyncExternalStore(subscribeHref, currentHref);
}

/** 現在の Route（URL の解釈）。選択・フィルタ・ドリル位置の SSOT */
export function useRoute(): Route {
  const href = useHref();
  return useMemo(() => parseRoute(href), [href]);
}

/**
 * グラフのドリル位置（null = トップレベル）。"/"（当日）はバッファが解決した
 * 当日チャンク id へ写すため、ロード完了までは null（トップレベル表示）になる。
 */
export function useDrillId(): number | null {
  const route = useRoute();
  const currentId = useBufferStore((s) => s.currentId);
  return drillIdOf(route.chunk, currentId);
}
