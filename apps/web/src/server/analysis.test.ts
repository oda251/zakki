import { describe, expect, test } from "bun:test";
import { createDb } from "@zakki/data/db/connect.ts";
import { createAnalysisScheduler } from "./analysis.ts";
import { createAnalysisEvents } from "./events.ts";

describe("AnalysisScheduler の完了フック", () => {
  test("解析パス完了のたびに onSettled が呼ばれる（SSE 配信の起点）", async () => {
    const db = await createDb(":memory:");
    let settled = 0;
    const scheduler = createAnalysisScheduler(
      db,
      null,
      () => {},
      0,
      () => {
        settled += 1;
      },
    );
    scheduler.schedule();
    await scheduler.settle();
    expect(settled).toBe(1);

    scheduler.schedule();
    await scheduler.settle();
    expect(settled).toBe(2);
  });
});

describe("AnalysisEvents（pub/sub）", () => {
  test("emit は購読者全員へ届き、解除後は届かない", () => {
    const events = createAnalysisEvents();
    const calls: string[] = [];
    const offA = events.subscribe(() => calls.push("a"));
    events.subscribe(() => calls.push("b"));
    events.emit();
    offA();
    events.emit();
    expect(calls).toEqual(["a", "b", "b"]);
  });
});
