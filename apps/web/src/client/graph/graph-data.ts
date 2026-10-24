export interface GraphTopology {
  nodeIds: readonly number[];
  edges: readonly { from: number; to: number; score: number }[];
}

export interface RetainedGraphData<T> {
  data: T;
  topology: GraphTopology;
}

export function retainGraphData<T>(
  previous: RetainedGraphData<T> | null,
  data: T,
  topology: GraphTopology,
): RetainedGraphData<T> {
  if (previous !== null && sameTopology(previous.topology, topology)) return previous;

  return {
    data,
    topology: {
      nodeIds: [...topology.nodeIds],
      edges: topology.edges.map(({ from, to, score }) => ({ from, to, score })),
    },
  };
}

function sameTopology(left: GraphTopology, right: GraphTopology): boolean {
  return (
    left.nodeIds.length === right.nodeIds.length &&
    left.nodeIds.every((id, index) => id === right.nodeIds[index]) &&
    left.edges.length === right.edges.length &&
    left.edges.every(
      (edge, index) =>
        edge.from === right.edges[index]?.from &&
        edge.to === right.edges[index]?.to &&
        edge.score === right.edges[index]?.score,
    )
  );
}
