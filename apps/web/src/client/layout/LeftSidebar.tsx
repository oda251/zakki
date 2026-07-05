import { useMemo, useState } from "react";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * 折り畳み可能な左メニュー（docs/CHUNKS.md）。セッション CRUD は廃し:
 * - 日付チャンク一覧（graph の parentId===null ノード、date 降順）。クリック = openChunk
 * - タグフィルタ chips（filter.tag / filter.userTag の解除）
 * - 現バッファ行のハイライト
 * コンテナ作成 UI は置かない（行を打って潜るのが作成、docs/CHUNKS.md §入力・保存）。
 */
export function LeftSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const data = useGraphStore((s) => s.data);
  const filter = useGraphStore((s) => s.filter);
  const setTagFilter = useGraphStore((s) => s.setTagFilter);
  const setUserTagFilter = useGraphStore((s) => s.setUserTagFilter);
  const current = useBufferStore((s) => s.current);
  const openChunk = useBufferStore((s) => s.openChunk);

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
          {filter.userTag !== null && (
            <button type="button" className="session-tag" onClick={() => setUserTagFilter(null)}>
              🏷{filter.userTag} ✕
            </button>
          )}
          {dateChunks.map((node) => {
            const active = current?.id === node.id;
            return (
              <div
                key={node.id}
                className={active ? "session-item session-item--active" : "session-item"}
                role="button"
                tabIndex={0}
                onClick={() => void openChunk(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void openChunk(node.id);
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
