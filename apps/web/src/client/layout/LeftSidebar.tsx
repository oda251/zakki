import { useState } from "react";
import {
  NODE_NEUTRAL,
  seriesSlotBySession,
  sessionColor,
  useGraphStore,
} from "@zakki/web/client/store/graph.ts";

/** 折り畳み可能な左メニュー: セッション一覧（色凡例を兼ねる）とフィルタ */
export function LeftSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const data = useGraphStore((s) => s.data);
  const filter = useGraphStore((s) => s.filter);
  const toggleSession = useGraphStore((s) => s.toggleSession);
  const clearSessionFilter = useGraphStore((s) => s.clearSessionFilter);
  const setTagFilter = useGraphStore((s) => s.setTagFilter);

  const sessions = data?.sessions ?? [];
  const slots = seriesSlotBySession(sessions);
  // 新しい日付が上（同日はデフォルト→名前付きの順で id 昇順）
  const ordered = [...sessions].toSorted((a, b) => b.date.localeCompare(a.date) || a.id - b.id);

  return (
    <nav className={collapsed ? "sidebar sidebar--collapsed" : "sidebar"}>
      <div className="sidebar__header">
        <button
          type="button"
          className="sidebar__toggle"
          aria-label={collapsed ? "メニューを開く" : "メニューを畳む"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? "»" : "«"}
        </button>
        {!collapsed && <span className="sidebar__title">zakki</span>}
      </div>
      {!collapsed && (
        <div className="sidebar__list">
          {filter.tag !== null && (
            <button type="button" className="session-tag" onClick={() => setTagFilter(null)}>
              #{filter.tag} ✕
            </button>
          )}
          {filter.sessionIds.size > 0 && (
            <button type="button" className="session-tag" onClick={clearSessionFilter}>
              フィルタ解除 ✕
            </button>
          )}
          {ordered.map((session) => {
            const active = filter.sessionIds.has(session.id);
            return (
              <button
                key={session.id}
                type="button"
                className={active ? "session-item session-item--active" : "session-item"}
                onClick={() => toggleSession(session.id)}
              >
                <span
                  className="session-item__dot"
                  style={{
                    background:
                      slots.get(session.id) === undefined
                        ? NODE_NEUTRAL
                        : sessionColor(slots.get(session.id)),
                  }}
                />
                <span className="session-item__name">{session.name ?? "（日次）"}</span>
                <span className="session-item__date">{session.date.slice(5)}</span>
              </button>
            );
          })}
          {ordered.length === 0 && <div className="empty-note">セッションがありません</div>}
        </div>
      )}
    </nav>
  );
}
