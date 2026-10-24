import { useMemo, useRef } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import { forceCollide } from "d3-force-3d";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import {
  cardLayout,
  NODE_CARD_FONT_SIZE,
  NODE_CARD_LINE_HEIGHT,
  NODE_CARD_PADDING,
} from "@zakki/web/client/graph/card-layout.ts";
import { useElementSize } from "@zakki/web/client/hooks/use-element-size.ts";
import { gotoChunk, selectNode } from "@zakki/web/client/router/navigate.ts";
import { useDrillId, useRoute } from "@zakki/web/client/router/use-route.ts";
import type { GraphNode } from "@zakki/web/shared/api-types.ts";
import {
  type ClickStamp,
  isDoubleClick,
  resolveNodeActivation,
  SERIES_SLOTS,
  seriesSlotsAtLevel,
  visibleGraph,
} from "@zakki/web/client/store/graph-core.ts";
import { retainGraphData, type RetainedGraphData } from "@zakki/web/client/graph/graph-data.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/** canvas は CSS 変数を解決できないため、実色は computed style から一度だけ読む */
function resolvePalette(): { series: string[]; neutral: string; ink: string; hairline: string } {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    series: Array.from({ length: SERIES_SLOTS }, (_, i) => read(`--series-${i + 1}`, "#3987e5")),
    neutral: read("--node-neutral", "#6b6a64"),
    ink: read("--text-secondary", "#c3c2b7"),
    hairline: read("--baseline", "#383835"),
  };
}

interface ForceNode {
  id: number;
  node: GraphNode;
  sourceContent: string;
  /** ドリル階層外だがリンクで引き込まれたノード（薄く描画する） */
  external: boolean;
  card: ReturnType<typeof cardLayout>;
  x?: number;
  y?: number;
}

/** force-graph に渡すリンク。ForceGraph2D の型引数にして各コールバックの引数型を導く */
interface ForceLink {
  source: number;
  target: number;
  score: number;
}

const NODE_RADIUS = 4;

export function GraphView() {
  const data = useGraphStore((s) => s.data);
  // ドリル位置・選択・フィルタは URL が SSOT（#52）。
  // Escape（親階層へ戻る）のキーマップも URL 遷移として router/controller.ts に集約済み。
  const drillId = useDrillId();
  const { select: selectedNodeId, filter } = useRoute();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const size = useElementSize(containerRef);
  const palette = useMemo(resolvePalette, []);
  const measureCardText = useMemo(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) return (text: string) => text.length * NODE_CARD_FONT_SIZE * 0.6;
    context.font = `${NODE_CARD_FONT_SIZE}px system-ui, sans-serif`;
    return (text: string) => context.measureText(text).width;
  }, []);
  const collisionForce = useMemo(
    () => forceCollide<NodeObject<ForceNode>>((fn) => fn.card.collisionRadius),
    [],
  );
  const graphRef = useRef<
    ForceGraphMethods<NodeObject<ForceNode>, LinkObject<ForceNode, ForceLink>> | undefined
  >(undefined);
  const collisionGraph = useRef<
    ForceGraphMethods<NodeObject<ForceNode>, LinkObject<ForceNode, ForceLink>> | undefined
  >(undefined);

  const visible = useMemo(
    (): ReturnType<typeof visibleGraph> =>
      data === null ? { nodes: [], edges: [] } : visibleGraph(data, drillId, filter),
    [data, drillId, filter],
  );
  const slots = useMemo(() => seriesSlotsAtLevel(visible.nodes), [visible]);

  // force-graph は graphData が変わるとシミュレーションを再加熱する。ノードラッパーを
  // id で使い回して座標（x/y）を引き継ぎ、フィルタ・ドリル切り替えでレイアウトが
  // 最初からやり直しになるのを避ける。
  const nodeCache = useRef(new Map<number, ForceNode>());
  const retainedGraphData = useRef<RetainedGraphData<{
    nodes: ForceNode[];
    links: ForceLink[];
  }> | null>(null);
  const graphData = useMemo(() => {
    const graphPayload = {
      nodes: visible.nodes.map(({ node, external }): ForceNode => {
        const cached = nodeCache.current.get(node.id);
        if (cached !== undefined) {
          cached.node = node;
          if (cached.sourceContent !== node.content) {
            cached.sourceContent = node.content;
            cached.card = cardLayout(node.content, measureCardText);
          }
          cached.external = external;
          return cached;
        }
        const created: ForceNode = {
          id: node.id,
          node,
          sourceContent: node.content,
          external,
          card: cardLayout(node.content, measureCardText),
        };
        nodeCache.current.set(node.id, created);
        return created;
      }),
      links: visible.edges.map((e) => ({ source: e.from, target: e.to, score: e.score })),
    };
    retainedGraphData.current = retainGraphData(retainedGraphData.current, graphPayload, {
      nodeIds: visible.nodes.map(({ node }) => node.id),
      edges: visible.edges,
      layoutKey: graphPayload.nodes.map(({ id, card }) => `${id}:${card.height}`).join("|"),
    });
    return retainedGraphData.current.data;
  }, [visible, measureCardText]);

  const colorOf = (fn: ForceNode): string => {
    const slot = slots.get(fn.node.id);
    return slot === undefined ? palette.neutral : (palette.series[slot] ?? palette.neutral);
  };

  // ダブルクリック判定・遷移先決定は graph-core の純関数（isDoubleClick /
  // resolveNodeActivation）に委譲し、ここは URL 遷移（gotoChunk / selectNode）の配線のみ。
  // シングル = 選択のみ（external も同じ、セッション移動しない）。
  const lastClick = useRef<ClickStamp | null>(null);
  const onNodeClick = (fn: ForceNode, event: MouseEvent) => {
    const now = Date.now();
    const double = isDoubleClick(lastClick.current, fn.id, now, event.detail);
    lastClick.current = { id: fn.id, at: now };
    if (!double) {
      selectNode(fn.id);
      return;
    }
    const activation = resolveNodeActivation(fn.node);
    if (activation.kind === "drill") {
      gotoChunk(activation.id);
    } else {
      gotoChunk(activation.parentId, activation.selectId);
    }
  };

  return (
    <div ref={containerRef} className="main-pane">
      {size.width > 0 && (
        <ForceGraph2D<ForceNode, ForceLink>
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor="transparent"
          linkColor={() => palette.hairline}
          linkWidth={(l) => Math.max(1, (l.score - 0.8) * 10)}
          ref={graphRef}
          onEngineTick={() => {
            const graph = graphRef.current;
            if (graph === undefined || collisionGraph.current === graph) return;
            collisionGraph.current = graph;
            graph.d3Force("collide", collisionForce);
            graph.d3ReheatSimulation();
          }}
          nodeRelSize={NODE_RADIUS}
          nodeLabel={({ node }) => `${node.date}<br/>${makeTitle(node.content)}`}
          nodeCanvasObject={(fn, ctx) => {
            const { card, external, node, x, y } = fn;
            if (x === undefined || y === undefined) return;
            const left = x - card.width / 2;
            const top = y - card.height / 2;
            ctx.save();
            ctx.globalAlpha = external ? 0.4 : 1;
            ctx.beginPath();
            ctx.rect(left, top, card.width, card.height);
            ctx.fillStyle = colorOf(fn);
            ctx.fill();
            if (node.id === selectedNodeId) {
              ctx.globalAlpha = 1;
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = "#ffffff";
              ctx.stroke();
            }
            ctx.beginPath();
            ctx.rect(
              left + NODE_CARD_PADDING,
              top + NODE_CARD_PADDING,
              card.width - NODE_CARD_PADDING * 2,
              card.height - NODE_CARD_PADDING * 2,
            );
            ctx.clip();
            ctx.globalAlpha = external ? 0.55 : 1;
            ctx.font = `${NODE_CARD_FONT_SIZE}px system-ui, sans-serif`;
            ctx.fillStyle = palette.ink;
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            card.lines.forEach((line, index) => {
              ctx.fillText(
                line,
                left + NODE_CARD_PADDING,
                top + NODE_CARD_PADDING + index * NODE_CARD_LINE_HEIGHT,
              );
            });
            ctx.restore();
          }}
          nodePointerAreaPaint={(fn, color, ctx) => {
            const { card, x, y } = fn;
            if (x === undefined || y === undefined) return;
            ctx.beginPath();
            ctx.rect(x - card.width / 2, y - card.height / 2, card.width, card.height);
            ctx.fillStyle = color;
            ctx.fill();
          }}
          onNodeClick={onNodeClick}
          onBackgroundClick={() => selectNode(null)}
        />
      )}
    </div>
  );
}
