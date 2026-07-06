import { useEffect, useRef, type RefObject } from "react";
import { EditBuffer, EditorView, type CliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import type { Editing } from "@zakki/core/input/store.ts";
import { globalDisplayCol, visualPosition } from "./width.ts";

/**
 * 端末ネイティブの縦棒カーソル（docs/PANES.md §3）の描画対象。
 * グリフ（▌等）を別セルに挿すと隙間が出るため、実カーソルをセル境界に置く方式に統一する。
 * - scope: カーソルを含む scrollbox（メイン or 詳細）。
 * - id: その scrollbox 内でカーソルを置く要素（box）の id。
 * - text: 表示中テキスト（折り返し位置の計測に使う。New は確定テキスト＋打鍵途中ローマ字）。
 * - offset: text 内のカーソル位置 [0, text.length]。
 */
export interface BarCursorTarget {
  scope: "main" | "detail";
  id: string;
  text: string;
  offset: number;
}

/**
 * 端末ネイティブ縦棒カーソルの描画対象を導出する純粋関数（docs/PANES.md §3）。
 * - 検索中・モーダル（ダイアログ / メニュー）表示中は null（カーソルを隠す）。
 * - 修正中はその編集箇所（main は該当リテラル、detail は表示 index）。
 * - それ以外で New 入力中なら末尾（確定テキスト＋打鍵途中ローマ字の直後）。
 * liveText は「確定テキスト＋打鍵途中ローマ字」を連結済みで渡す（offset は末尾）。
 */
export function computeBarTarget(args: {
  mode: "write" | "search";
  hasDialog: boolean;
  hasMenu: boolean;
  editing: Editing | null;
  clampedIndex: number;
  newFocused: boolean;
  liveText: string;
}): BarCursorTarget | null {
  const { mode, hasDialog, hasMenu, editing, clampedIndex, newFocused, liveText } = args;
  if (mode === "search" || hasDialog || hasMenu) {
    return null;
  }
  if (editing !== null) {
    if (editing.target.kind === "main") {
      return {
        scope: "main",
        id: `chunk-${editing.target.start}`,
        text: editing.text,
        offset: editing.cursor,
      };
    }
    return {
      scope: "detail",
      id: `detail-${clampedIndex}`,
      text: editing.text,
      offset: editing.cursor,
    };
  }
  if (newFocused) {
    return { scope: "main", id: "chunk-new", text: liveText, offset: liveText.length };
  }
  return null;
}

/** 折り返し計測に十分な高さ。チャンクは有界なので内部スクロールは起こさない */
const MEASURE_HEIGHT = 4096;

/**
 * 文字オフセットを折り返し後の画面セルへ写し、端末の line（縦棒）カーソルを置く。
 *
 * 通常の `<text>` にはオフセット→セルの公開 API が無いため、表示と同じテキストを
 * 計測用 EditorView に流し込み、getLineInfo() で折り返しレイアウトを取得する。
 * カーソル列は自前の globalDisplayCol / visualPosition で算出する（全角幅対応）。要素の screenX/screenY は
 * scrollbox のスクロール量を織り込み済みなので、補正なしでそのまま使える。
 * 表示窓の外（スクロールで隠れた行）に来たらカーソルを隠す。
 */
export function useBarCursor(
  renderer: CliRenderer,
  target: BarCursorTarget | null,
  scrolls: {
    main: RefObject<ScrollBoxRenderable | null>;
    detail: RefObject<ScrollBoxRenderable | null>;
  },
): void {
  // フレームコールバックは一度だけ登録し、最新の target は ref 越しに読む
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const buffer = EditBuffer.create(renderer.widthMethod);
    const view = EditorView.create(buffer, 1, MEASURE_HEIGHT);
    view.setWrapMode("word");
    // line=縦棒、点滅は端末既定（DECSCUSR）に委ねる
    renderer.setCursorStyle({ style: "line", blinking: true });
    let lastText: string | null = null;

    const hide = () => renderer.setCursorPosition(0, 0, false);

    const onFrame = async () => {
      const t = targetRef.current;
      if (t === null) {
        hide();
        return;
      }
      const sb = (t.scope === "main" ? scrolls.main : scrolls.detail).current;
      if (sb === null) {
        hide();
        return;
      }
      const node = sb.content.findDescendantById(t.id);
      if (node === undefined || !node.visible) {
        hide();
        return;
      }
      view.setViewportSize(Math.max(1, node.width), MEASURE_HEIGHT);
      if (lastText !== t.text) {
        buffer.setText(t.text);
        lastText = t.text;
      }
      const li = view.getLineInfo();
      const g = globalDisplayCol(t.text, Math.max(0, Math.min(t.text.length, t.offset)));
      const { row, cellCol } = visualPosition(li.lineStartCols, g);
      const cursorY = node.screenY + row;
      // scrollbox の表示窓（縦）から外れていれば隠す
      if (cursorY < sb.screenY || cursorY >= sb.screenY + sb.height) {
        hide();
        return;
      }
      // setCursorPosition は 1-based 絶対セル（index-07zpr2dg.js:6134 と同じ +1）
      renderer.setCursorPosition(node.screenX + cellCol + 1, cursorY + 1, true);
    };

    renderer.setFrameCallback(onFrame);
    return () => {
      renderer.removeFrameCallback(onFrame);
      hide();
      view.destroy();
      buffer.destroy();
    };
  }, [renderer, scrolls.main, scrolls.detail]);
}
