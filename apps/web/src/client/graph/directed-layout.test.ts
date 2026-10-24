import { describe, expect, test } from "bun:test";
import { directedTargets } from "./directed-layout.ts";

describe("directedTargets", () => {
  test("directed links place targets below sources while auto relations do not set depth", () => {
    const targets = directedTargets(
      [
        { id: 1, position: 0 },
        { id: 2, position: 0 },
        { id: 3, position: 1 },
        { id: 4, position: 2 },
      ],
      [
        { from: 1, to: 2, origin: "manual" },
        { from: 3, to: 4, origin: "auto" },
      ],
      new Map([
        [1, { width: 64, height: 22 }],
        [2, { width: 64, height: 22 }],
        [3, { width: 64, height: 22 }],
        [4, { width: 64, height: 22 }],
      ]),
    );

    expect(targets.get(2)?.y).toBeGreaterThan(targets.get(1)?.y ?? 0);
    expect(targets.get(4)?.y).toBe(targets.get(3)?.y);
  });

  test("row spacing accounts for card height and same-row nodes are ordered by position", () => {
    const nodes = [
      { id: 1, position: 0 },
      { id: 2, position: 0 },
      { id: 3, position: 1 },
    ];
    const edges = [{ from: 1, to: 2, origin: "manual" as const }];
    const cardSizes = new Map([
      [1, { width: 64, height: 22 }],
      [2, { width: 64, height: 22 }],
      [3, { width: 64, height: 22 }],
    ]);
    const targets = directedTargets(nodes, edges, cardSizes);
    const tallTargets = directedTargets(
      nodes,
      edges,
      new Map([...cardSizes, [2, { width: 64, height: 46 }]]),
    );

    expect(targets.get(1)?.x).toBeLessThan(targets.get(3)?.x ?? 0);
    expect((tallTargets.get(2)?.y ?? 0) - (tallTargets.get(1)?.y ?? 0)).toBeGreaterThan(
      (targets.get(2)?.y ?? 0) - (targets.get(1)?.y ?? 0),
    );
  });
});
