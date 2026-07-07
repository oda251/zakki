import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { gotoAll, gotoChunk } from "@zakki/web/client/router/navigate.ts";
import { useDrillId } from "@zakki/web/client/router/use-route.ts";
import { breadcrumbPath } from "@zakki/web/client/store/graph-core.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * ドリル位置のパンくずリスト（docs/CHUNKS.md §ナビゲーション）。グラフペイン上部に
 * オーバーレイし、`全体 > 2026-07-06 > <title> > …` を常置する。セグメントクリックで
 * その階層へ URL 遷移（#52）: 先頭「全体」= /all、それ以外は /c/:id（バッファも追随）。
 * 祖先列は breadcrumbPath（純関数）から得る。
 */
export function Breadcrumb() {
  const data = useGraphStore((s) => s.data);
  const drillId = useDrillId();

  if (data === null) return null;
  const path = breadcrumbPath(data, drillId);

  return (
    <nav className="breadcrumb" aria-label="階層">
      <button type="button" className="breadcrumb__seg" onClick={() => gotoAll()}>
        全体
      </button>
      {path.map((node) => (
        <span key={node.id} className="breadcrumb__group">
          <span className="breadcrumb__sep">›</span>
          <button type="button" className="breadcrumb__seg" onClick={() => gotoChunk(node.id)}>
            {node.parentId === null ? node.date : makeTitle(node.content)}
          </button>
        </span>
      ))}
    </nav>
  );
}
