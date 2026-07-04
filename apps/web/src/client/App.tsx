import { useEffect } from "react";
import { GraphView } from "@zakki/web/client/graph/GraphView.tsx";
import { LeftSidebar } from "@zakki/web/client/layout/LeftSidebar.tsx";
import { RightPanel } from "@zakki/web/client/layout/RightPanel.tsx";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";
import { useSessionStore } from "@zakki/web/client/store/session.ts";

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
        <GraphView />
      )}
      <RightPanel />
    </div>
  );
}
