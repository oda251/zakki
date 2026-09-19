import { gotoAll, gotoChunk } from "@zakki/web/client/router/navigate.ts";
import { currentHref, subscribeHref } from "@zakki/web/client/router/history.ts";
import {
  bufferKeyOf,
  type ChunkTarget,
  drillIdOf,
  parseRoute,
} from "@zakki/web/client/router/route.ts";
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
 * 入力欄に開くセッション。選択ノードがグラフ上にあれば、その属するセッション（親。
 * 日付ノード自身ならその日付）。無ければ URL のドリル位置どおり
 */
function sessionTarget(chunk: ChunkTarget, select: number | null): ChunkTarget {
  if (select === null) return chunk;
  const node = useGraphStore.getState().data?.nodes.find((n) => n.id === select);
  if (node === undefined) return chunk;
  return { kind: "chunk", id: node.parentId ?? node.id };
}

/**
 * ルーティングの imperative shell（issue #52）。main.tsx の合成点から DB 接続後に
 * 一度呼ぶ。React の外で 2 つの配線を持つ:
 * - URL → バッファ: ディープリンク・リロード・戻る/進むを含む全ての URL 変化で、
 *   開くチャンクが変わったときだけバッファをロードし直す（フィルタの replaceState や
 *   同じセッション内の選択では入力中の raw を壊さない）。選択ノードがあれば、入力欄は
 *   そのノードが属するセッション（日付ノードならその日付）を開く。グラフの階層（URL）は変えない
 * - キーマップ: Escape = 親階層へ戻る（docs/CHUNKS.md §ナビゲーション）。
 *   drillUp が URL 遷移になったため、購読ごとここへ集約する
 */
export function connectRouter(): () => void {
  let bufferKey = "";
  const syncBuffer = (): void => {
    const route = parseRoute(currentHref());
    const target = sessionTarget(route.chunk, route.select);
    const key = bufferKeyOf(target);
    if (key === bufferKey) return;
    bufferKey = key;
    const buffer = useBufferStore.getState();
    // 既に開いているセッション（例: 当日バッファを "today" で開いた後、当日の投稿を選んだ）は
    // 開き直さない。開き直すと入力中の内容が初期化される
    if (target.kind === "chunk" && target.id === buffer.currentId) return;
    if (target.kind === "chunk") {
      void buffer.openChunk(target.id);
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
  // 選択ノードの所属はグラフ（liveQuery 導出）から引く。ディープリンク直後はまだ無いので、
  // グラフが届いたら解決し直す（キーが変わらなければ何もしない）
  const unsubscribeGraph = useGraphStore.subscribe(syncBuffer);
  window.addEventListener("keydown", onKeyDown);
  return () => {
    unsubscribe();
    unsubscribeGraph();
    window.removeEventListener("keydown", onKeyDown);
  };
}
