import { describe, expect, test } from "bun:test";
import { retainGraphData, type GraphTopology } from "./graph-data.ts";

interface TestGraphData {
  nodes: { id: number; content?: string }[];
  links: unknown[];
}

const topology: GraphTopology = {
  nodeIds: [1, 2],
  edges: [{ from: 1, to: 2, score: 1 }],
};

describe("retainGraphData", () => {
  test("content-only updates retain graph data identity", () => {
    const initialData: TestGraphData = { nodes: [{ id: 1, content: "before" }], links: [] };
    const initial = retainGraphData<TestGraphData>(null, initialData, topology);
    const updatedData: TestGraphData = { nodes: [{ id: 1, content: "after" }], links: [] };

    const updated = retainGraphData(initial, updatedData, {
      nodeIds: [1, 2],
      edges: [{ from: 1, to: 2, score: 1 }],
    });

    expect(updated).toBe(initial);
    expect(updated.data).toBe(initialData);
  });

  test("node ID changes replace graph data", () => {
    const initialData: TestGraphData = { nodes: [{ id: 1 }], links: [] };
    const initial = retainGraphData<TestGraphData>(null, initialData, topology);
    const updatedData: TestGraphData = { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }], links: [] };

    const updated = retainGraphData(initial, updatedData, {
      nodeIds: [1, 2, 3],
      edges: [{ from: 1, to: 2, score: 1 }],
    });

    expect(updated).not.toBe(initial);
    expect(updated.data).toBe(updatedData);
  });

  test("edge changes replace graph data", () => {
    const initialData: TestGraphData = { nodes: [{ id: 1 }], links: [] };
    const initial = retainGraphData<TestGraphData>(null, initialData, topology);
    const updatedData: TestGraphData = { nodes: [{ id: 1 }], links: [] };

    const updated = retainGraphData(initial, updatedData, {
      nodeIds: [1, 2],
      edges: [{ from: 2, to: 1, score: 1 }],
    });

    expect(updated).not.toBe(initial);
    expect(updated.data).toBe(updatedData);
  });

  test("card geometry changes replace graph data but same geometry does not", () => {
    const initialData: TestGraphData = { nodes: [{ id: 1, content: "first" }], links: [] };
    const initial = retainGraphData<TestGraphData>(null, initialData, {
      ...topology,
      layoutKey: "1:38",
    });
    const sameLayoutData: TestGraphData = { nodes: [{ id: 1, content: "other text" }], links: [] };
    const sameLayout = retainGraphData(initial, sameLayoutData, {
      ...topology,
      layoutKey: "1:38",
    });

    expect(sameLayout).toBe(initial);

    const tallerCardData: TestGraphData = {
      nodes: [{ id: 1, content: "a\nsecond line" }],
      links: [],
    };
    const tallerCard = retainGraphData(sameLayout, tallerCardData, {
      ...topology,
      layoutKey: "1:54",
    });

    expect(tallerCard).not.toBe(initial);
    expect(tallerCard.data).toBe(tallerCardData);
  });
});
