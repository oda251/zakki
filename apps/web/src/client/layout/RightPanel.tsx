import { useMemo } from "react";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { chunkDigestWeb, chunkWeb } from "@zakki/web/client/chunk/chunk.web.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * 右パネル（Phase 4 は read-only: 選択ノードの詳細 + リンク近傍）。
 * Phase 5 でここに Composer.Web（入力欄）と意味的関連が載る。
 */
export function RightPanel() {
  const data = useGraphStore((s) => s.data);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const selectNode = useGraphStore((s) => s.selectNode);
  const setTagFilter = useGraphStore((s) => s.setTagFilter);

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

  return (
    <aside className="right-panel">
      <section className="right-panel__section">
        <h2 className="right-panel__heading">選択中の投稿</h2>
        {selected === null ? (
          <div className="empty-note">グラフのノードをクリックすると内容を表示します</div>
        ) : (
          <div>
            <div className={chunkDigestWeb.date}>
              {selected.date}
              {selected.sessionName !== null && ` / ${selected.sessionName}`}
            </div>
            <p className={`${chunkWeb.base} ${chunkWeb.selected}`}>{selected.content}</p>
            <div>
              {selected.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="session-tag"
                  onClick={() => setTagFilter(tag)}
                >
                  #{tag}
                </button>
              ))}
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
