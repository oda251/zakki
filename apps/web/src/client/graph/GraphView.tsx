import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import type { GraphNode } from "@zakki/web/shared/api-types.ts";
import { seriesSlotBySession, useGraphStore, visibleGraph } from "@zakki/web/client/store/graph.ts";

/** canvas は CSS 変数を解決できないため、実色は computed style から一度だけ読む */
function resolvePalette(): { series: string[]; neutral: string; ink: string; hairline: string } {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    series: Array.from({ length: 8 }, (_, i) => read(`--series-${i + 1}`, "#3987e5")),
    neutral: read("--node-neutral", "#6b6a64"),
    ink: read("--text-secondary", "#c3c2b7"),
    hairline: read("--baseline", "#383835"),
  };
}

interface ForceNode {
  id: number;
  node: GraphNode;
  x?: number;
  y?: number;
}

/** ラベルを描き始めるズーム倍率（引きの絵ではノード色のみ、寄ったらタイトル） */
const LABEL_MIN_SCALE = 1.6;
const NODE_RADIUS = 4;

export function GraphView() {
  const data = useGraphStore((s) => s.data);
  const filter = useGraphStore((s) => s.filter);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const selectNode = useGraphStore((s) => s.selectNode);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const palette = useMemo(resolvePalette, []);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const graphData = useMemo(() => {
    if (data === null) return { nodes: [], links: [] };
    const { nodes, edges } = visibleGraph(data, filter);
    return {
      nodes: nodes.map((node): ForceNode => ({ id: node.id, node })),
      links: edges.map((e) => ({ source: e.from, target: e.to, score: e.score })),
    };
  }, [data, filter]);

  const slotBySession = useMemo(
    () => (data === null ? new Map<number, number>() : seriesSlotBySession(data.sessions)),
    [data],
  );

  const colorOf = (node: GraphNode): string => {
    const slot = slotBySession.get(node.sessionId);
    return slot === undefined ? palette.neutral : (palette.series[slot] ?? palette.neutral);
  };

  return (
    <div ref={containerRef} className="main-pane">
      {size.width > 0 && (
        <ForceGraph2D
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor="transparent"
          linkColor={() => palette.hairline}
          linkWidth={(l) => Math.max(1, ((l as { score: number }).score - 0.8) * 10)}
          nodeRelSize={NODE_RADIUS}
          nodeLabel={(n) => {
            const { node } = n as ForceNode;
            return `${node.date}${node.sessionName === null ? "" : ` / ${node.sessionName}`}<br/>${makeTitle(node.content)}`;
          }}
          nodeCanvasObject={(n, ctx, globalScale) => {
            const { node, x, y } = n as ForceNode;
            if (x === undefined || y === undefined) return;
            ctx.beginPath();
            ctx.arc(x, y, NODE_RADIUS, 0, 2 * Math.PI);
            ctx.fillStyle = colorOf(node);
            ctx.fill();
            if (node.id === selectedNodeId) {
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = "#ffffff";
              ctx.stroke();
            }
            if (globalScale >= LABEL_MIN_SCALE) {
              ctx.font = `${Math.max(10 / globalScale, 3)}px system-ui, sans-serif`;
              ctx.fillStyle = palette.ink;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillText(makeTitle(node.content), x, y + NODE_RADIUS + 1);
            }
          }}
          onNodeClick={(n) => selectNode((n as ForceNode).id)}
          onBackgroundClick={() => selectNode(null)}
        />
      )}
    </div>
  );
}
