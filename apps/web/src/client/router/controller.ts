import { gotoAll, gotoChunk } from "@zakki/web/client/router/navigate.ts";
import { currentHref, subscribeHref } from "@zakki/web/client/router/history.ts";
import { bufferKeyOf, drillIdOf, parseRoute } from "@zakki/web/client/router/route.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { parentOf } from "@zakki/web/client/store/graph-core.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/** 入力欄フォーカス中はグローバルキーを奪わない（Composer は role=textbox） */
function isEditing(el: Element | null): boolean {
  if (el === null) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
  if (el.getAttribute("role") === "textbox") return true;
  return "isContentEditable" in el && el.isContentEditable === true;
}

/**
 * ルーティングの imperative shell（issue #52）。main.tsx の合成点から DB 接続後に
 * 一度呼ぶ。React の外で 2 つの配線を持つ:
 * - URL → バッファ: ディープリンク・リロード・戻る/進むを含む全ての URL 変化で、
 *   開くチャンクが変わったときだけバッファをロードし直す（選択・フィルタの
 *   replaceState では入力中の raw を壊さない）
 * - キーマップ: Escape = 親階層へ戻る（docs/CHUNKS.md §ナビゲーション）。
 *   drillUp が URL 遷移になったため、購読ごとここへ集約する
 */
export function connectRouter(): () => void {
  let bufferKey = "";
  const syncBuffer = (): void => {
    const route = parseRoute(currentHref());
    const key = bufferKeyOf(route.chunk);
    if (key === bufferKey) return;
    bufferKey = key;
    const buffer = useBufferStore.getState();
    if (route.chunk.kind === "chunk") {
      void buffer.openChunk(route.chunk.id);
    } else {
      void buffer.openToday();
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || isEditing(document.activeElement)) return;
    const route = parseRoute(currentHref());
    const drillId = drillIdOf(route.chunk, useBufferStore.getState().currentId);
    if (drillId === null) return;
    const data = useGraphStore.getState().data;
    const parentId = data === null ? null : parentOf(data, drillId);
    // 戻った先でどこから来たか分かるよう、元のドリル位置を選択状態にする
    if (parentId !== null) {
      gotoChunk(parentId, drillId);
    } else {
      gotoAll(drillId);
    }
  };

  syncBuffer();
  const unsubscribe = subscribeHref(syncBuffer);
  window.addEventListener("keydown", onKeyDown);
  return () => {
    unsubscribe();
    window.removeEventListener("keydown", onKeyDown);
  };
}
