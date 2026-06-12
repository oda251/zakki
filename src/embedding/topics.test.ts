import { describe, expect, test } from "bun:test";
import { detectBoundaries, groupByBoundaries } from "./topics.ts";

const v = (x: number, y: number) => {
  const n = Math.hypot(x, y);
  return Float32Array.from([x / n, y / n]);
};

describe("detectBoundaries", () => {
  test("隣接類似度の低下点を境界とする", () => {
    // 同方向・同方向・直交 → 3 番目の前が境界
    const boundaries = detectBoundaries([v(1, 0), v(0.95, 0.05), v(0, 1)], 0.8);
    expect(boundaries).toEqual([false, false, true]);
  });

  test("単一・空入力", () => {
    expect(detectBoundaries([v(1, 0)], 0.8)).toEqual([false]);
    expect(detectBoundaries([], 0.8)).toEqual([]);
  });
});

describe("groupByBoundaries", () => {
  test("境界で隣接要素をグループ化する", () => {
    expect(groupByBoundaries(["a", "b", "c", "d"], [false, false, true, false])).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("境界なしは 1 グループ", () => {
    expect(groupByBoundaries(["a", "b"], [false, false])).toEqual([["a", "b"]]);
  });
});
