import { describe, expect, test } from "bun:test";
import { createDb } from "@zakki/data/db/connect.ts";
import { createAnalysisScheduler } from "./scheduler.ts";

describe("AnalysisScheduler（デバウンス + 直列化）", () => {
  test("解析パス完了のたびに onSettled が呼ばれる", async () => {
    const db = await createDb(":memory:");
    let settled = 0;
    const scheduler = createAnalysisScheduler({
      db,
      embedder: null,
      onError: () => {},
      debounceMs: 0,
      onSettled: () => {
        settled += 1;
      },
    });
    scheduler.schedule();
    await scheduler.settle();
    expect(settled).toBe(1);

    scheduler.schedule();
    await scheduler.settle();
    expect(settled).toBe(2);
  });

  test("連続 schedule はデバウンスされ解析パスは 1 回にまとまる", async () => {
    const db = await createDb(":memory:");
    let settled = 0;
    const scheduler = createAnalysisScheduler({
      db,
      embedder: null,
      onError: () => {},
      debounceMs: 5,
      onSettled: () => {
        settled += 1;
      },
    });
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await scheduler.settle();
    expect(settled).toBe(1);
  });

  test("onSettled の失敗は onError に流れ、以降の schedule は動き続ける", async () => {
    const db = await createDb(":memory:");
    const errors: string[] = [];
    let calls = 0;
    const scheduler = createAnalysisScheduler({
      db,
      embedder: null,
      onError: (m) => errors.push(m),
      debounceMs: 0,
      onSettled: () => {
        calls += 1;
        if (calls === 1) throw new Error("後処理の失敗");
      },
    });
    scheduler.schedule();
    await scheduler.settle();
    expect(errors).toEqual(["後処理の失敗"]);

    scheduler.schedule();
    await scheduler.settle();
    expect(calls).toBe(2);
  });
});
