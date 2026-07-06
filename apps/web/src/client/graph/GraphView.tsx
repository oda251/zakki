import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { clampText } from "@zakki/web/client/graph/clamp.ts";
import type { GraphNode } from "@zakki/web/shared/api-types.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import {
  type ClickStamp,
  isDoubleClick,
  parentOf,
  resolveNodeActivation,
  SERIES_SLOTS,
  seriesSlotsAtLevel,
  type VisibleNode,
  visibleGraph,
} from "@zakki/web/client/store/graph-core.ts";
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
  /** ドリル階層外だがリンクで引き込まれたノード（薄く描画する） */
  external: boolean;
  /** clamp 済みラベル（毎フレームの Segmenter 実行を避けるため生成時に計算） */
  label: string;
  x?: number;
  y?: number;
}

const NODE_RADIUS = 4;

/** 半径は descendantCount の対数スケール（大きなコンテナほど大きく, docs/CHUNKS.md） */
function nodeRadius(descendantCount: number): number {
  return NODE_RADIUS * (1 + Math.log2(1 + descendantCount) / 3);
}

/** childCount > 0 のコンテナはひし形（◆）、葉は円（〇）で描く */
function traceShape(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  if (node.childCount > 0) {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, 2 * Math.PI);
  }
}

export function GraphView() {
  const data = useGraphStore((s) => s.data);
  const drillId = useGraphStore((s) => s.drillId);
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

  // Escape = 親階層へ戻る（docs/CHUNKS.md §ナビゲーション）。現ドリルノードの parentId が
  // 非 null なら所属バッファへ、null（日付チャンク）なら drillTo(null)（バッファ維持）。
  // 入力欄（input / textarea / contenteditable / role=textbox=Composer）フォーカス中は無視。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el !== null &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable ||
          el.getAttribute("role") === "textbox")
      ) {
        return;
      }
      const { data: current, drillId: id } = useGraphStore.getState();
      if (id === null) return;
      const parentId = current === null ? null : parentOf(current, id);
      if (parentId !== null) {
        void useBufferStore.getState().openChunk(parentId);
      } else {
        useGraphStore.getState().drillTo(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = useMemo(
    () =>
      data === null
        ? { nodes: [] as VisibleNode[], edges: [] }
        : visibleGraph(data, drillId, filter),
    [data, drillId, filter],
  );
  const slots = useMemo(() => seriesSlotsAtLevel(visible.nodes), [visible]);

  // force-graph は graphData が変わるとシミュレーションを再加熱する。ノードラッパーを
  // id で使い回して座標（x/y）を引き継ぎ、フィルタ・ドリル切り替えでレイアウトが
  // 最初からやり直しになるのを避ける。
  const nodeCache = useRef(new Map<number, ForceNode>());
  const graphData = useMemo(() => {
    return {
      nodes: visible.nodes.map(({ node, external }): ForceNode => {
        const cached = nodeCache.current.get(node.id);
        if (cached !== undefined) {
          if (cached.node !== node) {
            cached.node = node;
            cached.label = clampText(node.content);
          }
          cached.external = external;
          return cached;
        }
        const created: ForceNode = {
          id: node.id,
          node,
          external,
          label: clampText(node.content),
        };
        nodeCache.current.set(node.id, created);
        return created;
      }),
      links: visible.edges.map((e) => ({ source: e.from, target: e.to, score: e.score })),
    };
  }, [visible]);

  const colorOf = (fn: ForceNode): string => {
    const slot = slots.get(fn.node.id);
    return slot === undefined ? palette.neutral : (palette.series[slot] ?? palette.neutral);
  };

  // ダブルクリック判定・遷移先決定は graph-core の純関数（isDoubleClick /
  // resolveNodeActivation）に委譲し、ここは openChunk / selectNode の配線のみ。
  // シングル = 選択のみ（external も同じ、セッション移動しない）。
  const lastClick = useRef<ClickStamp | null>(null);
  const onNodeClick = (raw: object, event: MouseEvent) => {
    const fn = raw as ForceNode;
    const now = Date.now();
    const double = isDoubleClick(lastClick.current, fn.id, now, event.detail);
    lastClick.current = { id: fn.id, at: now };
    if (!double) {
      selectNode(fn.id);
      return;
    }
    const activation = resolveNodeActivation(fn.node);
    if (activation.kind === "drill") {
      void useBufferStore.getState().openChunk(activation.id);
    } else {
      void useBufferStore
        .getState()
        .openChunk(activation.parentId)
        .then(() => useGraphStore.getState().selectNode(activation.selectId));
    }
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
            return `${node.date}<br/>${makeTitle(node.content)}`;
          }}
          nodeCanvasObject={(n, ctx, globalScale) => {
            const fn = n as ForceNode;
            const { node, external, label, x, y } = fn;
            if (x === undefined || y === undefined) return;
            const r = nodeRadius(node.descendantCount);
            ctx.save();
            // external はドリル階層外の引き込みノード: それ自体を薄く描く
            ctx.globalAlpha = external ? 0.4 : 1;
            traceShape(ctx, node, x, y, r);
            ctx.fillStyle = colorOf(fn);
            ctx.fill();
            if (node.id === selectedNodeId) {
              ctx.globalAlpha = 1;
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = "#ffffff";
              ctx.stroke();
            }
            // 本文の clamp ラベルを常時表示（ドリル表示でノード数は絞られている前提）
            const fontSize = Math.min(Math.max(10 / globalScale, 3), 8);
            ctx.globalAlpha = external ? 0.55 : 1;
            ctx.font = `${fontSize}px system-ui, sans-serif`;
            ctx.fillStyle = palette.ink;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(label, x, y + r + 1);
            ctx.restore();
          }}
          nodePointerAreaPaint={(n, color, ctx) => {
            const { node, x, y } = n as ForceNode;
            if (x === undefined || y === undefined) return;
            traceShape(ctx, node, x, y, nodeRadius(node.descendantCount));
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
