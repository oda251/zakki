import { describe, expect, test } from "bun:test";
import { computeLinks } from "./linker.ts";

describe("computeLinks", () => {
  test("名詞を 2 つ以上共有し類似度が閾値以上ならリンクする", () => {
    const links = computeLinks(
      new Map([
        [1, ["変換", "辞書", "学習"]],
        [2, ["変換", "辞書", "候補"]],
        [3, ["散歩", "天気"]],
      ]),
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromChunkId: 1, toChunkId: 2 });
    expect(links[0]?.score).toBeCloseTo(2 / 4);
  });

  test("共有 1 語ではリンクしない", () => {
    const links = computeLinks(
      new Map([
        [1, ["変換", "辞書"]],
        [2, ["変換", "散歩"]],
      ]),
    );
    expect(links).toEqual([]);
  });

  test("ペアは from < to に正規化される", () => {
    const links = computeLinks(
      new Map([
        [9, ["変換", "辞書"]],
        [2, ["変換", "辞書"]],
      ]),
    );
    expect(links[0]).toMatchObject({ fromChunkId: 2, toChunkId: 9 });
  });
});
