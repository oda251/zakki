import { describe, expect, test } from "bun:test";
import { matchDraftsToExisting } from "./match.ts";

/** 突き合わせカーネル（サーバ repository / web writes が共有する不変条件） */
const row = (id: number, content: string) => ({ id, content });

describe("matchDraftsToExisting", () => {
  test("content 完全一致は並び替えを跨いで対応し、同文は position 順に消費する", () => {
    const existing = [row(1, "a"), row(2, "a"), row(3, "b")];
    const { assigned, removed } = matchDraftsToExisting(existing, [
      { content: "b" },
      { content: "a" },
      { content: "a" },
    ]);
    expect(assigned.map((r) => r?.id)).toEqual([3, 1, 2]);
    expect(removed).toEqual([]);
  });

  test("未対応の草稿は未使用の既存行を position 順に再利用する（= 編集行）", () => {
    const existing = [row(1, "a"), row(2, "b")];
    const { assigned, removed } = matchDraftsToExisting(existing, [
      { content: "a" },
      { content: "b2" },
    ]);
    expect(assigned.map((r) => r?.id)).toEqual([1, 2]);
    expect(removed).toEqual([]);
  });

  test("どの草稿にも対応しない既存行は removed に載り、新規草稿は undefined", () => {
    const existing = [row(1, "a"), row(2, "b"), row(3, "c")];
    const { assigned, removed } = matchDraftsToExisting(existing, [
      { content: "a" },
      { content: "新規" },
      { content: "もう一つ" },
    ]);
    expect(assigned.map((r) => r?.id)).toEqual([1, 2, 3]);
    expect(removed).toEqual([]);

    const shrink = matchDraftsToExisting(existing, [{ content: "c" }]);
    expect(shrink.assigned.map((r) => r?.id)).toEqual([3]);
    expect(shrink.removed.map((r) => r.id)).toEqual([1, 2]);
  });
});
