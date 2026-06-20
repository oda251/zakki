import { describe, expect, test } from "bun:test";
import { computeTags } from "./tagger.ts";

describe("computeTags", () => {
  test("固有のキーワードが共通語より上位になる（TF-IDF）", () => {
    const tags = computeTags(
      new Map([
        [1, ["変換", "辞書"]],
        [2, ["変換", "検索"]],
        [3, ["変換", "散歩"]],
      ]),
    );
    // 「変換」は全チャンクに出るため IDF が低く、固有語が先頭に来る
    expect(tags.get(1)?.[0]?.name).toBe("辞書");
    expect(tags.get(2)?.[0]?.name).toBe("検索");
  });

  test("チャンクあたり最大 3 タグ", () => {
    const tags = computeTags(new Map([[1, ["あ", "い", "う", "え", "お"].map((s) => s + s)]]));
    expect(tags.get(1)).toHaveLength(3);
  });

  test("名詞がないチャンクは空", () => {
    expect(computeTags(new Map([[1, []]])).get(1)).toEqual([]);
  });

  test("決定的（同入力同出力）", () => {
    const input = new Map([
      [1, ["設計", "変換"]],
      [2, ["設計", "検索"]],
    ]);
    expect(computeTags(input)).toEqual(computeTags(input));
  });
});
