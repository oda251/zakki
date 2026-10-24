import { describe, expect, test } from "bun:test";
import { cardLayout, NODE_CARD_MAX_GRAPHEMES } from "./card-layout.ts";

describe("cardLayout", () => {
  test("wraps full short content and sizes a card around its lines", () => {
    const layout = cardLayout("abcde", (text) => text.length * 10);

    expect(layout.lines).toEqual(["abcde"]);
    expect(layout.width).toBe(180);
    expect(layout.height).toBe(38);
    expect(layout.collisionRadius).toBeGreaterThan(90);
  });

  test("wraps content at the card width", () => {
    const layout = cardLayout("abcdefghijklmnopqrst", (text) => text.length * 10);

    expect(layout.lines).toEqual(["abcdefghijklmnop", "qrst"]);
  });

  test("truncates display at 280 graphemes without changing source content", () => {
    const source = "日".repeat(NODE_CARD_MAX_GRAPHEMES + 5);
    const layout = cardLayout(source, (text) => text.length * 10);

    expect(layout.lines.join("").replace("…", "")).toBe("日".repeat(NODE_CARD_MAX_GRAPHEMES));
    expect(layout.lines.at(-1)?.endsWith("…")).toBe(true);
    expect(source.length).toBe(NODE_CARD_MAX_GRAPHEMES + 5);
  });

  test("sizes collision bounds from wrapped card height", () => {
    const short = cardLayout("abc", (text) => text.length * 10);
    const long = cardLayout("a".repeat(64), (text) => text.length * 10);

    expect(long.height).toBeGreaterThan(short.height);
    expect(long.collisionRadius).toBeGreaterThan(short.collisionRadius);
  });
});
