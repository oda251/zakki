import { describe, expect, test } from "bun:test";
import { TopicGrouper } from "./grouper.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** 先頭文字でトピック方向が決まるフェイク埋め込み */
const fakeEmbed = (texts: string[]) =>
  Promise.resolve(
    texts.map((t) => (t.startsWith("天") ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))),
  );

describe("TopicGrouper", () => {
  test("未計算時は 1 文 1 グループ、計算後は話題でまとまる", async () => {
    let updates = 0;
    const grouper = new TopicGrouper(
      fakeEmbed,
      () => {
        updates += 1;
      },
      0.8,
    );

    const sentences = ["天気の話。", "天候の続き。", "仕事の話。"];
    expect(grouper.group(sentences)).toEqual([["天気の話。"], ["天候の続き。"], ["仕事の話。"]]);

    await tick();
    expect(updates).toBe(1);
    expect(grouper.group(sentences)).toEqual([["天気の話。", "天候の続き。"], ["仕事の話。"]]);
  });

  test("埋め込み失敗時は 1 文 1 グループのまま", async () => {
    const grouper = new TopicGrouper(
      () => Promise.reject(new Error("model unavailable")),
      () => {},
    );
    const sentences = ["一つ。", "二つ。"];
    grouper.group(sentences);
    await tick();
    expect(grouper.group(sentences)).toEqual([["一つ。"], ["二つ。"]]);
  });

  test("1 文以下はそのまま", () => {
    const grouper = new TopicGrouper(fakeEmbed, () => {});
    expect(grouper.group(["ひとつ。"])).toEqual([["ひとつ。"]]);
    expect(grouper.group([])).toEqual([]);
  });
});
