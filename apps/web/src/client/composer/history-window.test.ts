import { describe, expect, test } from "bun:test";
import { historyWindow } from "@zakki/web/client/composer/history-window.ts";

/**
 * 入力欄の吹き出しに既定で出す範囲（折り畳み時）。選択ノードを「最新」とみなし、
 * その直前 1 件と合わせて 2 件を出す。返すのは frozen 配列の [start, end)。
 */
describe("historyWindow", () => {
  test("選択が無ければ末尾 2 件", () => {
    expect(historyWindow({ total: 5, selectedIndex: null, savedCount: 5 })).toEqual([3, 5]);
  });

  test("選択があれば、選択とその直前の 1 件", () => {
    expect(historyWindow({ total: 5, selectedIndex: 1, savedCount: 5 })).toEqual([0, 2]);
    expect(historyWindow({ total: 5, selectedIndex: 3, savedCount: 5 })).toEqual([2, 4]);
  });

  test("先頭が選ばれたら 1 件だけ", () => {
    expect(historyWindow({ total: 5, selectedIndex: 0, savedCount: 5 })).toEqual([0, 1]);
  });

  test("選択が保存済みの最後なら、その後ろの未保存（Enter 直後）も含めて末尾 2 件", () => {
    // Enter で確定した直後は保存（と選択の移動）が 300ms 遅れる。新しい吹き出しを隠さない
    expect(historyWindow({ total: 6, selectedIndex: 4, savedCount: 5 })).toEqual([4, 6]);
  });

  test("件数が少なければある分だけ", () => {
    expect(historyWindow({ total: 1, selectedIndex: null, savedCount: 1 })).toEqual([0, 1]);
    expect(historyWindow({ total: 0, selectedIndex: null, savedCount: 0 })).toEqual([0, 0]);
  });
});
