import { useMemo, useState } from "react";
import { gotoChunk, setTagFilter, setUserTagFilter } from "@zakki/web/client/router/navigate.ts";
import { useDrillId, useRoute } from "@zakki/web/client/router/use-route.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/** 折り畳み状態は URL でも導出でもない UI 設定なので localStorage へ永続化する（#52） */
const COLLAPSED_KEY = "zakki.sidebar.collapsed";

/**
 * 折り畳み可能な左メニュー（docs/CHUNKS.md）。セッション CRUD は廃し:
 * - 日付チャンク一覧（graph の parentId===null ノード、date 降順）。クリック = /c/:id へ遷移
 * - タグフィルタ chips（?tag= / ?utag= の解除）
 * - 現バッファ（ドリル位置）行のハイライト
 * コンテナ作成 UI は置かない（行を打って潜るのが作成、docs/CHUNKS.md §入力・保存）。
 */
export function LeftSidebar() {
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(COLLAPSED_KEY) === "1",
  );
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      window.localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1");
      return !v;
    });
  };
  const data = useGraphStore((s) => s.data);
  const { filter } = useRoute();
  const drillId = useDrillId();

  // 新しい日付が上（date 降順）
  const dateChunks = useMemo(
    () =>
      (data?.nodes ?? [])
        .filter((n) => n.parentId === null)
        .toSorted((a, b) => b.date.localeCompare(a.date)),
    [data],
  );

  return (
    <nav className={collapsed ? "sidebar sidebar--collapsed" : "sidebar"}>
      <div className="sidebar__header">
        <button
          type="button"
          className="sidebar__toggle"
          aria-label={collapsed ? "メニューを開く" : "メニューを畳む"}
          onClick={toggleCollapsed}
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
          {filter.userTag !== null && (
            <button type="button" className="session-tag" onClick={() => setUserTagFilter(null)}>
              🏷{filter.userTag} ✕
            </button>
          )}
          {dateChunks.map((node) => {
            const active = drillId === node.id;
            return (
              <div
                key={node.id}
                className={active ? "session-item session-item--active" : "session-item"}
                role="button"
                tabIndex={0}
                onClick={() => gotoChunk(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") gotoChunk(node.id);
                }}
              >
                <span className="session-item__name">{node.date}</span>
                <span className="session-item__date">{node.childCount}</span>
              </div>
            );
          })}
          {dateChunks.length === 0 && <div className="empty-note">まだ記録がありません</div>}
        </div>
      )}
    </nav>
  );
}
