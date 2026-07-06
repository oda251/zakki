import { describe, expect, test } from "bun:test";
import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import { selectAmbient } from "./ambient.ts";

const TODAY = "2026-07-05";

const chunk = (id: number, date: string, content = `c${id}`): ChunkWithDate => ({
  id,
  parentId: 0,
  position: id,
  content,
  date,
  polarity: null,
});

const vec = (x: number, y: number): Float32Array => Float32Array.from([x, y]);

describe("selectAmbient", () => {
  test("当日チャンクが無ければ空（基準が取れない）", () => {
    const all = [chunk(1, "2026-07-04")];
    const vectors = new Map([[1, vec(1, 0)]]);
    expect(selectAmbient(all, vectors, TODAY, 5)).toEqual([]);
  });

  test("基準チャンクのベクトルが無ければ空", () => {
    const all = [chunk(1, TODAY)];
    const vectors = new Map<number, Float32Array>();
    expect(selectAmbient(all, vectors, TODAY, 5)).toEqual([]);
  });

  test("基準（当日最後）自身は結果から除外する", () => {
    // last = id 2。両者とも query と cosine=1 だが、自己は除外される。
    const all = [chunk(1, TODAY), chunk(2, TODAY)];
    const vectors = new Map([
      [1, vec(1, 0)],
      [2, vec(1, 0)],
    ]);
    const items = selectAmbient(all, vectors, TODAY, 5);
    expect(items.map((i) => i.chunkId)).toEqual([1]);
    expect(items[0]).toEqual({ chunkId: 1, date: TODAY, content: "c1" });
  });

  test("limit で切り詰める（自己除外後の上位 limit 件）", () => {
    // last = id 5（query）。スコア降順は 5>1>2>3>4。topK=limit+1=3 → [5,1,2]、
    // 自己(5)除外 → [1,2]、limit=2 で切り詰め。
    const all = [
      chunk(1, TODAY),
      chunk(2, TODAY),
      chunk(3, TODAY),
      chunk(4, TODAY),
      chunk(5, TODAY),
    ];
    const vectors = new Map([
      [1, vec(1, 0.1)],
      [2, vec(1, 0.2)],
      [3, vec(1, 0.3)],
      [4, vec(1, 0.5)],
      [5, vec(1, 0)],
    ]);
    const items = selectAmbient(all, vectors, TODAY, 2);
    expect(items.map((i) => i.chunkId)).toEqual([1, 2]);
  });
});
