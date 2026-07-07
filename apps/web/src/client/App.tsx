import { lazy, Suspense } from "react";
import { Breadcrumb } from "@zakki/web/client/graph/Breadcrumb.tsx";
import { GraphViewErrorBoundary } from "@zakki/web/client/GraphViewErrorBoundary.tsx";
import { LeftSidebar } from "@zakki/web/client/layout/LeftSidebar.tsx";
import { RightPanel } from "@zakki/web/client/layout/RightPanel.tsx";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

// react-force-graph-2d（d3 一式）が重いため、グラフ描画は初期チャンクから分離する
const GraphView = lazy(() =>
  import("@zakki/web/client/graph/GraphView.tsx").then((m) => ({ default: m.GraphView })),
);

/**
 * データ取得の配線は持たない（#44）: グラフ・バッファは main.tsx の bootstrap が
 * RxDB に接続した時点から liveQuery 購読で自動更新される。
 */
export function App() {
  const error = useGraphStore((s) => s.error);

  return (
    <div className="app-shell">
      <LeftSidebar />
      <div className="graph-pane">
        <Breadcrumb />
        {error !== null ? (
          <div className="empty-note main-pane">読み込みエラー: {error}</div>
        ) : (
          <GraphViewErrorBoundary>
            <Suspense fallback={<div className="empty-note main-pane">グラフを読み込み中…</div>}>
              <GraphView />
            </Suspense>
          </GraphViewErrorBoundary>
        )}
      </div>
      <RightPanel />
    </div>
  );
}
