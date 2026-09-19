import { describe, expect, test } from "bun:test";
import { historyWindow } from "@zakki/web/client/composer/history-window.ts";

/**
 * 入力欄の吹き出しに既定で出す範囲（折り畳み時）。アンカー（選択中のチャンク＝次の投稿の
 * 挿入位置の直前）を「最新」とみなし、その直前 1 件と合わせて 2 件を出す。
 * 返すのは frozen 配列の [start, end)。アンカーが無ければ末尾。
 */
describe("historyWindow", () => {
  test("アンカーが無ければ末尾 2 件", () => {
    expect(historyWindow({ total: 5, anchorIndex: null })).toEqual([3, 5]);
  });

  test("アンカーがあれば、アンカーとその直前の 1 件", () => {
    expect(historyWindow({ total: 5, anchorIndex: 1 })).toEqual([0, 2]);
    expect(historyWindow({ total: 5, anchorIndex: 3 })).toEqual([2, 4]);
  });

  test("先頭がアンカーなら 1 件だけ", () => {
    expect(historyWindow({ total: 5, anchorIndex: 0 })).toEqual([0, 1]);
  });

  test("件数が少なければある分だけ", () => {
    expect(historyWindow({ total: 1, anchorIndex: null })).toEqual([0, 1]);
    expect(historyWindow({ total: 0, anchorIndex: null })).toEqual([0, 0]);
  });
});
