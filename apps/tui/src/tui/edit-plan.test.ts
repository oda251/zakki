import { describe, expect, test } from "bun:test";
import type { Editing } from "@zakki/core/input/store.ts";
import type { EditTarget } from "@zakki/core/input/store.ts";
import { planEditCommit, type EditCommitCtx } from "./edit-plan.ts";

const TODAY = "2026-07-05";
const DATE_CHUNK_ID = 100;

const editing = (target: EditTarget, text: string): Editing => ({
  target,
  text,
  cursor: text.length,
  old: "old",
});

const ctx = (over: Partial<EditCommitCtx> = {}): EditCommitCtx => ({
  today: TODAY,
  dateChunkId: DATE_CHUNK_ID,
  parentId: DATE_CHUNK_ID,
  resolveBlock: () => ({ start: 10, end: 20 }),
  ...over,
});

describe("planEditCommit", () => {
  test("空確定（空白のみ）は revert", () => {
    const plan = planEditCommit(editing({ kind: "main", start: 2, end: 5 }, "   "), ctx());
    expect(plan).toEqual({ kind: "revert" });
  });

  test("main は rawReplace（text は trim 済み）", () => {
    const plan = planEditCommit(editing({ kind: "main", start: 2, end: 5 }, "  hi  "), ctx());
    expect(plan).toEqual({ kind: "rawReplace", start: 2, end: 5, text: "hi" });
  });

  test("detail 当日直下は resolveBlock で rawReplace", () => {
    const target: EditTarget = { kind: "detail", date: TODAY, position: 3, chunkId: 9 };
    const plan = planEditCommit(editing(target, "hi"), ctx({ parentId: DATE_CHUNK_ID }));
    expect(plan).toEqual({ kind: "rawReplace", start: 10, end: 20, text: "hi" });
  });

  test("detail 当日直下でも領域解決に失敗すれば null（エラー表示）", () => {
    const target: EditTarget = { kind: "detail", date: TODAY, position: 3, chunkId: 9 };
    const plan = planEditCommit(editing(target, "hi"), ctx({ resolveBlock: () => null }));
    expect(plan).toBeNull();
  });

  test("detail 過去日は detailUpdate（id 直更新）", () => {
    const target: EditTarget = { kind: "detail", date: "2026-07-01", position: 3, chunkId: 9 };
    const plan = planEditCommit(editing(target, "hi"), ctx());
    expect(plan).toEqual({ kind: "detailUpdate", chunkId: 9, text: "hi", date: "2026-07-01" });
  });

  test("detail 当日でも親が日付チャンク直下でなければ detailUpdate", () => {
    const target: EditTarget = { kind: "detail", date: TODAY, position: 3, chunkId: 9 };
    const plan = planEditCommit(editing(target, "hi"), ctx({ parentId: 999 }));
    expect(plan).toEqual({ kind: "detailUpdate", chunkId: 9, text: "hi", date: TODAY });
  });
});
