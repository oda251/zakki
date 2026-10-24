export interface DirectedLayoutNode {
  id: number;
  position: number;
}

export interface DirectedLayoutEdge {
  from: number;
  to: number;
  origin: "manual" | "chrono" | "auto";
}

export interface CardSize {
  width: number;
  height: number;
}

export interface LayoutTarget {
  x: number;
  y: number;
}

const CARD_GAP = 24;
const ROW_GAP = 32;

export function directedTargets(
  nodes: readonly DirectedLayoutNode[],
  edges: readonly DirectedLayoutEdge[],
  cardSizes: ReadonlyMap<number, CardSize>,
): Map<number, LayoutTarget> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const depth = new Map(nodes.map(({ id }) => [id, 0]));
  const children = new Map<number, number[]>();
  const indegree = new Map(nodes.map(({ id }) => [id, 0]));

  for (const edge of edges) {
    if (edge.origin === "auto" || !nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const ready = nodes.filter(({ id }) => indegree.get(id) === 0).map(({ id }) => id);
  for (let index = 0; index < ready.length; index += 1) {
    const from = ready[index];
    if (from === undefined) continue;
    for (const to of children.get(from) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, (depth.get(from) ?? 0) + 1));
      const remaining = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, remaining);
      if (remaining === 0) ready.push(to);
    }
  }

  const rows = new Map<number, DirectedLayoutNode[]>();
  let maxDepth = 0;
  for (const node of nodes) {
    const row = depth.get(node.id) ?? 0;
    maxDepth = Math.max(maxDepth, row);
    const rowNodes = rows.get(row);
    if (rowNodes === undefined) rows.set(row, [node]);
    else rowNodes.push(node);
  }

  const targets = new Map<number, LayoutTarget>();
  const rowHeights = new Map<number, number>();
  for (const [row, rowNodes] of rows) {
    const ordered = rowNodes.toSorted((a, b) => a.position - b.position || a.id - b.id);
    const widths = ordered.map(({ id }) => cardSizes.get(id)?.width ?? 0);
    const totalWidth =
      widths.reduce((total, width) => total + width, 0) + CARD_GAP * (ordered.length - 1);
    let left = -totalWidth / 2;
    let rowHeight = 0;
    for (const node of ordered) {
      const size = cardSizes.get(node.id) ?? { width: 0, height: 0 };
      targets.set(node.id, { x: left + size.width / 2, y: 0 });
      left += size.width + CARD_GAP;
      rowHeight = Math.max(rowHeight, size.height);
    }
    rowHeights.set(row, rowHeight);
  }

  let y = 0;
  for (let row = 0; row <= maxDepth; row += 1) {
    const height = rowHeights.get(row);
    if (height === undefined) continue;
    const centerY = y + height / 2;
    for (const node of rows.get(row) ?? []) {
      const target = targets.get(node.id);
      if (target !== undefined) targets.set(node.id, { x: target.x, y: centerY });
    }
    y += height + ROW_GAP;
  }

  return targets;
}
