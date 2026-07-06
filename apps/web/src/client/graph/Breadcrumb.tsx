import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { breadcrumbPath } from "@zakki/web/client/store/graph-core.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * ドリル位置のパンくずリスト（docs/CHUNKS.md §ナビゲーション）。グラフペイン上部に
 * オーバーレイし、`全体 > 2026-07-06 > <title> > …` を常置する。セグメントクリックで
 * その階層へジャンプ: 先頭「全体」= drillTo(null)（バッファ維持）、それ以外は
 * openChunk(id)（バッファも切替）。祖先列は breadcrumbPath（純関数）から得る。
 */
export function Breadcrumb() {
  const data = useGraphStore((s) => s.data);
  const drillId = useGraphStore((s) => s.drillId);
  const drillTo = useGraphStore((s) => s.drillTo);
  const openChunk = useBufferStore((s) => s.openChunk);

  if (data === null) return null;
  const path = breadcrumbPath(data, drillId);

  return (
    <nav className="breadcrumb" aria-label="階層">
      <button type="button" className="breadcrumb__seg" onClick={() => drillTo(null)}>
        全体
      </button>
      {path.map((node) => (
        <span key={node.id} className="breadcrumb__group">
          <span className="breadcrumb__sep">›</span>
          <button type="button" className="breadcrumb__seg" onClick={() => void openChunk(node.id)}>
            {node.parentId === null ? node.date : makeTitle(node.content)}
          </button>
        </span>
      ))}
    </nav>
  );
}
