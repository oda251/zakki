import { describe, expect, test } from "bun:test";
import { chainLinks, newChunkIds } from "./auto-link.ts";

describe("newChunkIds（保存応答からの新チャンク検出）", () => {
  test("直前の既知 id に無い id を保存順で返す", () => {
    expect(newChunkIds([1, 2], [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])).toEqual([3, 4]);
  });

  test("新チャンクが無ければ空", () => {
    expect(newChunkIds([1, 2], [{ id: 1 }, { id: 2 }])).toEqual([]);
  });

  test("初回保存（既知なし）は全チャンクが新規", () => {
    expect(newChunkIds([], [{ id: 5 }])).toEqual([5]);
  });
});

describe("chainLinks（選択中の投稿からの数珠繋ぎ）", () => {
  test("アンカー → 新1 → 新2 と連鎖する", () => {
    expect(chainLinks(10, [3, 4])).toEqual([
      { from: 10, to: 3 },
      { from: 3, to: 4 },
    ]);
  });

  test("選択中の投稿が無ければリンクは張らない（新チャンク間も張らない＝選択のみ移動）", () => {
    expect(chainLinks(null, [3])).toEqual([]);
    expect(chainLinks(null, [3, 4])).toEqual([{ from: 3, to: 4 }]);
  });

  test("アンカー自身が新チャンクに含まれても自己リンクは作らない", () => {
    expect(chainLinks(3, [3, 4])).toEqual([{ from: 3, to: 4 }]);
  });

  test("新チャンクなしは空", () => {
    expect(chainLinks(10, [])).toEqual([]);
  });
});
