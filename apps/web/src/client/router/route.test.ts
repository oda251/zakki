import { describe, expect, test } from "bun:test";
import {
  bufferKeyOf,
  drillIdOf,
  formatRoute,
  parseRoute,
  type Route,
} from "@zakki/web/client/router/route.ts";

/**
 * issue #52: URL を SSOT にするルーティングの純粋ロジック。受け入れ基準
 * 「/c/123?select=456&tag=x を直接開くと該当階層・選択・フィルタが復元される」の
 * URL → 状態導出（ドリル位置・選択・フィルタ）をここで担保する。
 * バッファ復元（openChunk）は buffer.test.ts、ドリル表示は graph-core.test.ts が担う。
 */
describe("parseRoute", () => {
  test("受け入れ基準: /c/123?select=456&tag=x から階層・選択・フィルタが復元される", () => {
    const route = parseRoute("/c/123?select=456&tag=x");
    expect(route.chunk).toEqual({ kind: "chunk", id: 123 });
    expect(route.select).toBe(456);
    expect(route.filter).toEqual({ tag: "x", userTag: null });
    // グラフのドリル位置・バッファのロード対象も URL だけから決まる
    expect(drillIdOf(route.chunk, null)).toBe(123);
    expect(bufferKeyOf(route.chunk)).toBe("chunk:123");
  });

  test("/ は当日（既定）。ドリル位置はバッファが解決した当日チャンク id へ写す", () => {
    const route = parseRoute("/");
    expect(route).toEqual({
      chunk: { kind: "today" },
      select: null,
      filter: { tag: null, userTag: null },
    });
    expect(drillIdOf(route.chunk, null)).toBeNull(); // ロード完了まで
    expect(drillIdOf(route.chunk, 7)).toBe(7);
  });

  test("/all はトップレベル（ドリルなし）。バッファは当日を共有する", () => {
    const route = parseRoute("/all?utag=work");
    expect(route.chunk).toEqual({ kind: "all" });
    expect(route.filter).toEqual({ tag: null, userTag: "work" });
    expect(drillIdOf(route.chunk, 7)).toBeNull();
    expect(bufferKeyOf(route.chunk)).toBe("today");
  });

  test("不明なパス・不正な id は当日へ倒す", () => {
    expect(parseRoute("/nosuch").chunk).toEqual({ kind: "today" });
    expect(parseRoute("/c/abc").chunk).toEqual({ kind: "today" });
    expect(parseRoute("/c/1/2").chunk).toEqual({ kind: "today" });
    expect(parseRoute("/c/123?select=abc").select).toBeNull();
  });
});

describe("formatRoute", () => {
  test("parseRoute と往復する", () => {
    const routes: Route[] = [
      { chunk: { kind: "today" }, select: null, filter: { tag: null, userTag: null } },
      { chunk: { kind: "all" }, select: 9, filter: { tag: null, userTag: null } },
      { chunk: { kind: "chunk", id: 123 }, select: 456, filter: { tag: "x", userTag: "y" } },
    ];
    for (const route of routes) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });

  test("クエリが空ならパスのみ", () => {
    expect(
      formatRoute({
        chunk: { kind: "chunk", id: 5 },
        select: null,
        filter: { tag: null, userTag: null },
      }),
    ).toBe("/c/5");
  });

  test("タグ名の記号は URL エンコードして往復する", () => {
    const route: Route = {
      chunk: { kind: "today" },
      select: null,
      filter: { tag: "あ/&=", userTag: null },
    };
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });
});
