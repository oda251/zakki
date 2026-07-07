import { describe, expect, test } from "bun:test";
import { chainLinks, newChunkIds, planAutoLink } from "./auto-link.ts";

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

/**
 * PR #79 レビュー対応の再現テスト: type → 300ms 以内にドリルすると、バッファ切替後に
 * 後着した保存（データ保全のため走らせる）が切替先 URL の ?select= をアンカーに読み、
 * バッファを跨いだ誤リンクの永続化 + 切替先 URL の選択の誤上書きが起きていた。
 * 発火時点で保存先バッファが URL 上も開かれているときだけ副作用（リンク・選択）を計画する。
 */
describe("planAutoLink（後着保存の副作用ガード）", () => {
  const base = { parentId: 5, anchor: 10, freshIds: [3, 4] };

  test("同一バッファ（/c/:parentId）ならアンカーからの連鎖と選択更新を計画する", () => {
    const plan = planAutoLink({ ...base, chunk: { kind: "chunk", id: 5 }, currentId: 5 });
    expect(plan).toEqual({
      links: [
        { from: 10, to: 3 },
        { from: 3, to: 4 },
      ],
      select: 4,
    });
  });

  test("再現: バッファ切替後（URL が別チャンク）は誤リンク・選択上書きをしない", () => {
    // /c/5 で type → 300ms 以内に /c/9?select=42 へドリル → 保存が後着
    expect(planAutoLink({ ...base, chunk: { kind: "chunk", id: 9 }, currentId: 9 })).toBeNull();
    // バッファ解決（currentId）が遅れていても URL 優先で判定する
    expect(planAutoLink({ ...base, chunk: { kind: "chunk", id: 9 }, currentId: 5 })).toBeNull();
  });

  test("当日バッファ（/・/all）は解決済みの currentId で同一性を判定する", () => {
    // "/" で当日（=5）に type → そのまま発火
    expect(planAutoLink({ ...base, chunk: { kind: "today" }, currentId: 5 })).not.toBeNull();
    expect(planAutoLink({ ...base, chunk: { kind: "all" }, currentId: 5 })).not.toBeNull();
    // /c/5 で type → "/"（当日=別チャンク）へ遷移後に後着
    expect(planAutoLink({ ...base, chunk: { kind: "today" }, currentId: 8 })).toBeNull();
    // 当日バッファの解決前（ロード中）は同一と断定できないため副作用を見送る
    expect(planAutoLink({ ...base, chunk: { kind: "today" }, currentId: null })).toBeNull();
  });

  test("新チャンクなしは計画なし", () => {
    expect(
      planAutoLink({ ...base, freshIds: [], chunk: { kind: "chunk", id: 5 }, currentId: 5 }),
    ).toBeNull();
  });

  test("アンカーは予約時点の捕捉値を使う（null なら連鎖のみ・選択は移す）", () => {
    const plan = planAutoLink({
      ...base,
      anchor: null,
      freshIds: [3],
      chunk: { kind: "chunk", id: 5 },
      currentId: 5,
    });
    expect(plan).toEqual({ links: [], select: 3 });
  });
});
