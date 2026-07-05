import { lazy, Suspense, useEffect } from "react";
import { GraphViewErrorBoundary } from "@zakki/web/client/GraphViewErrorBoundary.tsx";
import { LeftSidebar } from "@zakki/web/client/layout/LeftSidebar.tsx";
import { RightPanel } from "@zakki/web/client/layout/RightPanel.tsx";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import { useSessionStore } from "@zakki/web/client/store/session.ts";

// react-force-graph-2d（d3 一式）が重いため、グラフ描画は初期チャンクから分離する
const GraphView = lazy(() =>
  import("@zakki/web/client/graph/GraphView.tsx").then((m) => ({ default: m.GraphView })),
);

export function App() {
  const load = useGraphStore((s) => s.load);
  const error = useGraphStore((s) => s.error);
  const openToday = useSessionStore((s) => s.openToday);

  useEffect(() => {
    void load();
    void openToday();
  }, [load, openToday]);

  return (
    <div className="app-shell">
      <LeftSidebar />
      {error !== null ? (
        <div className="empty-note main-pane">読み込みエラー: {error}</div>
      ) : (
        <GraphViewErrorBoundary>
          <Suspense fallback={<div className="empty-note main-pane">グラフを読み込み中…</div>}>
            <GraphView />
          </Suspense>
        </GraphViewErrorBoundary>
      )}
      <RightPanel />
    </div>
  );
}
