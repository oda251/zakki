import { useMemo, useState } from "react";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { chunkDigestWeb, chunkWeb } from "@zakki/web/client/chunk/chunk.web.ts";
import { ComposerPane } from "@zakki/web/client/composer/ComposerPane.tsx";
import { docId } from "@zakki/web/client/db/ids.ts";
import { removeChunkTree, renameChunkDoc, setUserTagDocs } from "@zakki/web/client/db/writes.ts";
import { currentHref } from "@zakki/web/client/router/history.ts";
import {
  gotoChunk,
  gotoToday,
  selectNode,
  setTagFilter,
  setUserTagFilter,
} from "@zakki/web/client/router/navigate.ts";
import { parseRoute } from "@zakki/web/client/router/route.ts";
import { useRoute } from "@zakki/web/client/router/use-route.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * 右パネル: 上=Composer.Web（入力欄）、
 * 下=グラフで選択中のノード詳細（自動/ユーザタグ・ナビ・rename・削除）+ リンク近傍。
 * 選択・フィルタ・ナビゲーションは URL が SSOT（#52, router/navigate.ts）。
 * 書込みはローカル RxDB へ（#44）。グラフ表示は liveQuery 購読で自動更新される。
 * 意味的関連（アンビエント）はサーバ解析（embedder）の撤去（#45）と同時に消えた。
 * クライアント解析での復活は #28/#26。
 */
export function RightPanel() {
  const data = useGraphStore((s) => s.data);
  const selectedNodeId = useRoute().select;
  const db = useBufferStore((s) => s.db);
  const currentId = useBufferStore((s) => s.currentId);
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
    if (db === null) return;
    const names = (tagsDraft ?? "")
      .split(/[,、\s]+/u)
      .map((t) => t.trim())
      .filter((t) => t !== "");
    setTagsDraft(null);
    await setUserTagDocs(db, docId(id), names);
  };

  const renameContainer = async (id: number, previous: string) => {
    if (db === null) return;
    const content = (renaming ?? "").trim();
    setRenaming(null);
    if (content === "" || content === previous) return;
    // バッファの見出し表示はグラフ（liveQuery）から導出されるため開き直しは不要
    await renameChunkDoc(db, docId(id), content);
  };

  const deleteNode = async (id: number) => {
    if (db === null) return;
    if (!window.confirm("このチャンクを削除しますか？子孫も消えます。")) return;
    await removeChunkTree(db, docId(id));
    selectNode(null);
    // 現バッファが消えた場合は当日へ。URL が /c/… なら遷移（router が開き直す）、
    // 既に当日（"/"・"/all"）なら日付チャンクを作り直して開く
    if (currentId === id) {
      if (parseRoute(currentHref()).chunk.kind === "chunk") {
        gotoToday();
      } else {
        await openToday();
      }
    }
  };

  return (
    <aside className="right-panel">
      <section className="right-panel__section">
        <h2 className="right-panel__heading">入力</h2>
        <ComposerPane />
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
                  onClick={() => gotoChunk(selected.id)}
                >
                  中を開く →
                </button>
              ) : (
                selected.parentId !== null && (
                  <button
                    type="button"
                    className="session-tag"
                    onClick={() => gotoChunk(selected.parentId ?? selected.id)}
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
