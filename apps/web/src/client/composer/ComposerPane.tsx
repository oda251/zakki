import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { Composer } from "@zakki/web/client/composer/Composer.tsx";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * Composer の合成点: 現在のバッファ（親チャンク）が揃ったら Composer を組み立てる。
 * バッファ切替は key で丸ごと作り直す（store も張り直し）。
 * web はかな漢字変換エンジンを持たない（issue #149）: 日本語は OS の IME（composition）
 * で入力し、凍結リテラルとして入る。以前の anco wasm 埋め込みは、配信サイズ
 * （reactor ~13MB + 辞書 ~7MB）と Workers 上の配信の壊れやすさから撤去した。
 * バッファの見出しはグラフ（liveQuery）から導出するため、rename も自動で追随する。
 */
export function ComposerPane() {
  const db = useBufferStore((s) => s.db);
  const currentId = useBufferStore((s) => s.currentId);
  const initialRaw = useBufferStore((s) => s.initialRaw);
  const initialChunkIds = useBufferStore((s) => s.initialChunkIds);
  const error = useBufferStore((s) => s.error);
  const currentNode = useGraphStore((s) =>
    currentId === null ? undefined : s.data?.nodes.find((n) => n.id === currentId),
  );

  if (error !== null) {
    return <div className="empty-note">バッファ読み込みエラー: {error}</div>;
  }
  if (db === null || currentId === null || initialRaw === null) {
    return <div className="empty-note">読み込み中…</div>;
  }
  return (
    <div>
      <div className="composer__session">
        {currentNode === undefined
          ? "…"
          : currentNode.parentId === null
            ? currentNode.date
            : makeTitle(currentNode.content)}
      </div>
      <Composer
        key={currentId}
        db={db}
        parentId={currentId}
        initialRaw={initialRaw}
        initialChunkIds={initialChunkIds}
      />
    </div>
  );
}
