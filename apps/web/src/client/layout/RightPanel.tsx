import { useMemo, useState } from "react";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { api } from "@zakki/web/client/api/client.ts";
import { chunkDigestWeb, chunkWeb } from "@zakki/web/client/chunk/chunk.web.ts";
import { ComposerPane } from "@zakki/web/client/composer/ComposerPane.tsx";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * 右パネル: 上=Composer.Web（入力欄）、中=意味的関連（アンビエント）、
 * 下=グラフで選択中のノード詳細（自動/ユーザタグ・ナビ・rename・削除）+ リンク近傍。
 */
export function RightPanel() {
  const data = useGraphStore((s) => s.data);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setTagFilter = useGraphStore((s) => s.setTagFilter);
  const setUserTagFilter = useGraphStore((s) => s.setUserTagFilter);
  const reloadGraph = useGraphStore((s) => s.load);
  const related = useBufferStore((s) => s.related);
  const current = useBufferStore((s) => s.current);
  const openChunk = useBufferStore((s) => s.openChunk);
  const openToday = useBufferStore((s) => s.openToday);

  const [tagsDraft, setTagsDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const nodesById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const selected = selectedNodeId === null ? null : (nodesById.get(selectedNodeId) ?? null);

  // グラフの links から選択ノードの隣接を引く（双方向）
  const neighbors = useMemo(() => {
    if (data === null || selected === null) return [];
    return data.edges
      .filter((e) => e.from === selected.id || e.to === selected.id)
      .map((e) => (e.from === selected.id ? e.to : e.from))
      .flatMap((id) => {
        const node = nodesById.get(id);
        return node === undefined ? [] : [node];
      });
  }, [data, selected, nodesById]);

  const saveUserTags = async (id: number) => {
    const names = (tagsDraft ?? "")
      .split(/[,、\s]+/u)
      .map((t) => t.trim())
      .filter((t) => t !== "");
    setTagsDraft(null);
    await api.setUserTags(id, names);
    await reloadGraph();
  };

  const renameContainer = async (id: number, previous: string) => {
    const content = (renaming ?? "").trim();
    setRenaming(null);
    if (content === "" || content === previous) return;
    await api.renameChunk(id, content);
    await reloadGraph();
    // rename したノードが現バッファなら本文表示を更新するため開き直す
    if (current?.id === id) await openChunk(id);
  };

  const deleteNode = async (id: number) => {
    if (!window.confirm("このチャンクを削除しますか？子孫も消えます。")) return;
    await api.deleteChunk(id);
    selectNode(null);
    await reloadGraph();
    // 現バッファ（またはその祖先）が消えた場合に備え、開き直せなければ当日へ
    if (current?.id === id) await openToday();
  };

  return (
    <aside className="right-panel">
      <section className="right-panel__section">
        <h2 className="right-panel__heading">入力</h2>
        <ComposerPane />
      </section>
      <section className="right-panel__section">
        <h2 className="right-panel__heading">関連</h2>
        {related.length === 0 ? (
          <div className="empty-note">入力すると関連する過去の投稿が表示されます</div>
        ) : (
          related.map((item) => (
            <button
              key={item.chunkId}
              type="button"
              className={chunkDigestWeb.base}
              onClick={() => selectNode(item.chunkId)}
            >
              <span className={chunkDigestWeb.date}>{item.date}</span>
              {makeTitle(item.content)}
            </button>
          ))
        )}
      </section>
      <section className="right-panel__section">
        <h2 className="right-panel__heading">選択中の投稿</h2>
        {selected === null ? (
          <div className="empty-note">グラフのノードをクリックすると内容を表示します</div>
        ) : (
          <div>
            <div className={chunkDigestWeb.date}>{selected.date}</div>
            {renaming !== null && selected.childCount > 0 ? (
              <input
                className="sidebar__input"
                value={renaming}
                autoFocus
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void renameContainer(selected.id, selected.content);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => void renameContainer(selected.id, selected.content)}
              />
            ) : (
              <p className={`${chunkWeb.base} ${chunkWeb.selected}`}>{selected.content}</p>
            )}
            <div>
              {selected.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="session-tag"
                  title="この自動タグで絞り込む"
                  onClick={() => setTagFilter(tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
            <div className="session-item__actions">
              {tagsDraft !== null ? (
                <input
                  className="sidebar__input"
                  placeholder="タグ（空白・カンマ区切り）"
                  value={tagsDraft}
                  autoFocus
                  onChange={(e) => setTagsDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveUserTags(selected.id);
                    if (e.key === "Escape") setTagsDraft(null);
                  }}
                  onBlur={() => void saveUserTags(selected.id)}
                />
              ) : (
                <>
                  {selected.userTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="session-tag"
                      title="このユーザタグで絞り込む"
                      onClick={() => setUserTagFilter(tag)}
                    >
                      🏷{tag}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="session-tag"
                    onClick={() => setTagsDraft(selected.userTags.join(" "))}
                  >
                    🏷タグ編集
                  </button>
                </>
              )}
            </div>
            <div className="session-item__actions">
              {selected.childCount > 0 ? (
                <button
                  type="button"
                  className="session-tag"
                  onClick={() => void openChunk(selected.id)}
                >
                  中を開く →
                </button>
              ) : (
                selected.parentId !== null && (
                  <button
                    type="button"
                    className="session-tag"
                    onClick={() => void openChunk(selected.parentId ?? selected.id)}
                  >
                    所属セッションを開く →
                  </button>
                )
              )}
              {selected.childCount > 0 && (
                <button
                  type="button"
                  className="session-tag"
                  onClick={() => setRenaming(selected.content)}
                >
                  ✎名前変更
                </button>
              )}
              <button
                type="button"
                className="session-tag"
                onClick={() => void deleteNode(selected.id)}
              >
                ✕削除
              </button>
            </div>
          </div>
        )}
      </section>
      {selected !== null && (
        <section className="right-panel__section">
          <h2 className="right-panel__heading">関連（リンク）</h2>
          {neighbors.length === 0 ? (
            <div className="empty-note">リンクされた投稿はありません</div>
          ) : (
            neighbors.map((node) => (
              <button
                key={node.id}
                type="button"
                className={chunkDigestWeb.base}
                onClick={() => selectNode(node.id)}
              >
                <span className={chunkDigestWeb.date}>{node.date}</span>
                {makeTitle(node.content)}
              </button>
            ))
          )}
        </section>
      )}
    </aside>
  );
}
