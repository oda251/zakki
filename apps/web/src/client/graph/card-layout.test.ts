import { describe, expect, test } from "bun:test";
import { cardLayout, NODE_CARD_MAX_GRAPHEMES } from "./card-layout.ts";

describe("cardLayout", () => {
  test("wraps full short content and sizes a card around its lines", () => {
    const layout = cardLayout("abcde", (text) => text.length * 10);

    expect(layout.lines).toEqual(["abcde"]);
    expect(layout.width).toBe(64);
    expect(layout.height).toBe(22);
    expect(layout.collisionRadius).toBeLessThan(50);
  });

  test("wraps content at the card width", () => {
    const layout = cardLayout("abcdefghijklmnopqrst", (text) => text.length * 10);

    expect(layout.lines).toEqual(["abcde", "fghij", "klmno", "pqrst"]);
  });

  test("truncates display at 36 graphemes without changing source content", () => {
    expect(NODE_CARD_MAX_GRAPHEMES).toBe(36);
    const source = "日".repeat(41);
    const layout = cardLayout(source, (text) => text.length * 10);

    expect(layout.lines.join("").replace("…", "")).toBe("日".repeat(36));
    expect(layout.lines.at(-1)?.endsWith("…")).toBe(true);
    expect(source.length).toBe(41);
  });

  test("sizes collision bounds from wrapped card height", () => {
    const short = cardLayout("abc", (text) => text.length * 10);
    const long = cardLayout("a".repeat(64), (text) => text.length * 10);

    expect(long.height).toBeGreaterThan(short.height);
    expect(long.collisionRadius).toBeGreaterThan(short.collisionRadius);
  });
});
