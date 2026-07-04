import { useMemo, useState } from "react";
import { api } from "@zakki/web/client/api/client.ts";
import { seriesSlotBySession, sessionColor, useGraphStore } from "@zakki/web/client/store/graph.ts";
import { useSessionStore } from "@zakki/web/client/store/session.ts";
import type { SessionWithTags } from "@zakki/web/shared/api-types.ts";

/**
 * 折り畳み可能な左メニュー。セッション一覧（色凡例を兼ねる）と管理 UI:
 * - 行クリック = そのセッションを Composer で開く
 * - 色ドットクリック = グラフのセッションフィルタをトグル
 * - ＋ = 名前付きセッションを当日に作成 / アクティブ行で rename・タグ編集・削除
 */
export function LeftSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tagsDraft, setTagsDraft] = useState<string | null>(null);
  const data = useGraphStore((s) => s.data);
  const filter = useGraphStore((s) => s.filter);
  const toggleSession = useGraphStore((s) => s.toggleSession);
  const clearSessionFilter = useGraphStore((s) => s.clearSessionFilter);
  const setTagFilter = useGraphStore((s) => s.setTagFilter);
  const setSessionTagFilter = useGraphStore((s) => s.setSessionTagFilter);
  const reloadGraph = useGraphStore((s) => s.load);
  const current = useSessionStore((s) => s.current);
  const openSession = useSessionStore((s) => s.openSession);
  const openToday = useSessionStore((s) => s.openToday);

  const sessions = data?.sessions;
  const slots = useMemo(() => seriesSlotBySession(sessions ?? []), [sessions]);
  // 新しい日付が上（同日はデフォルト→名前付きの順で id 昇順）
  const ordered = useMemo(
    () => (sessions ?? []).toSorted((a, b) => b.date.localeCompare(a.date) || a.id - b.id),
    [sessions],
  );

  const createSession = async () => {
    const name = (draftName ?? "").trim();
    setDraftName(null);
    if (name === "") return;
    const session = await api.createSession(name);
    await reloadGraph();
    await openSession(session.id);
  };

  const renameSession = async (session: SessionWithTags) => {
    const name = (renaming ?? "").trim();
    setRenaming(null);
    if (name === "" || name === session.name) return;
    await api.renameSession(session.id, name);
    await reloadGraph();
    if (current?.id === session.id) await openSession(session.id);
  };

  const saveTags = async (session: SessionWithTags) => {
    const names = (tagsDraft ?? "")
      .split(/[,、\s]+/u)
      .map((t) => t.trim())
      .filter((t) => t !== "");
    setTagsDraft(null);
    await api.setSessionTags(session.id, names);
    await reloadGraph();
  };

  const deleteSession = async (session: SessionWithTags) => {
    if (
      !window.confirm(
        `セッション「${session.name ?? session.date}」を削除しますか？投稿も消えます。`,
      )
    ) {
      return;
    }
    await api.deleteSession(session.id);
    await reloadGraph();
    if (current?.id === session.id) await openToday();
  };

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
        {!collapsed && (
          <button
            type="button"
            className="sidebar__toggle"
            aria-label="名前付きセッションを作成"
            title="名前付きセッションを作成（当日）"
            onClick={() => setDraftName("")}
          >
            ＋
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="sidebar__list">
          {draftName !== null && (
            <input
              className="sidebar__input"
              placeholder="セッション名"
              value={draftName}
              autoFocus
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createSession();
                if (e.key === "Escape") setDraftName(null);
              }}
              onBlur={() => void createSession()}
            />
          )}
          {filter.tag !== null && (
            <button type="button" className="session-tag" onClick={() => setTagFilter(null)}>
              #{filter.tag} ✕
            </button>
          )}
          {filter.sessionTag !== null && (
            <button type="button" className="session-tag" onClick={() => setSessionTagFilter(null)}>
              🏷{filter.sessionTag} ✕
            </button>
          )}
          {filter.sessionIds.size > 0 && (
            <button type="button" className="session-tag" onClick={clearSessionFilter}>
              フィルタ解除 ✕
            </button>
          )}
          {ordered.map((session) => {
            const filtered = filter.sessionIds.has(session.id);
            const active = current?.id === session.id;
            return (
              <div key={session.id}>
                <div
                  className={active ? "session-item session-item--active" : "session-item"}
                  role="button"
                  tabIndex={0}
                  onClick={() => void openSession(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void openSession(session.id);
                  }}
                >
                  <button
                    type="button"
                    className={
                      filtered ? "session-item__dot session-item__dot--on" : "session-item__dot"
                    }
                    aria-label="グラフをこのセッションで絞り込む"
                    title="グラフをこのセッションで絞り込む"
                    style={{ background: sessionColor(slots.get(session.id)) }}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSession(session.id);
                    }}
                  />
                  {renaming !== null && active ? (
                    <input
                      className="sidebar__input"
                      value={renaming}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") void renameSession(session);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => void renameSession(session)}
                    />
                  ) : (
                    <span className="session-item__name">{session.name ?? "（日次）"}</span>
                  )}
                  <span className="session-item__date">{session.date.slice(5)}</span>
                </div>
                {session.tags.length > 0 && (
                  <div className="session-item__tags">
                    {session.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="session-tag"
                        title="このセッションタグで絞り込む"
                        onClick={() => setSessionTagFilter(tag)}
                      >
                        🏷{tag}
                      </button>
                    ))}
                  </div>
                )}
                {active && (
                  <div className="session-item__actions">
                    {tagsDraft !== null ? (
                      <input
                        className="sidebar__input"
                        placeholder="タグ（空白・カンマ区切り）"
                        value={tagsDraft}
                        autoFocus
                        onChange={(e) => setTagsDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveTags(session);
                          if (e.key === "Escape") setTagsDraft(null);
                        }}
                        onBlur={() => void saveTags(session)}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="session-tag"
                          onClick={() => setTagsDraft(session.tags.join(" "))}
                        >
                          🏷タグ編集
                        </button>
                        {session.name !== null && (
                          <button
                            type="button"
                            className="session-tag"
                            onClick={() => setRenaming(session.name ?? "")}
                          >
                            ✎名前変更
                          </button>
                        )}
                        {session.name !== null && (
                          <button
                            type="button"
                            className="session-tag"
                            onClick={() => void deleteSession(session)}
                          >
                            ✕削除
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {ordered.length === 0 && <div className="empty-note">セッションがありません</div>}
        </div>
      )}
    </nav>
  );
}
