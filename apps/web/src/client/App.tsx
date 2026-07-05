import { useEffect } from "react";
import { subscribeAnalysis } from "@zakki/web/client/api/events.ts";
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

  // サーバ解析（タグ・極性・意味リンク）の完了を SSE で受け、その時だけ再取得する。
  // 新規ノード自体は保存応答の楽観的更新（Composer → applySaved）で即時反映済み
  useEffect(
    () =>
      subscribeAnalysis(() => {
        void useGraphStore.getState().load();
        void useSessionStore.getState().refreshRelated();
      }),
    [],
  );

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
