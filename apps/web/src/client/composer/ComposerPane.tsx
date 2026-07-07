import { useMemo } from "react";
import { take } from "rxjs";
import { makeTitle } from "@zakki/core/chunk/chunker.ts";
import { Composer } from "@zakki/web/client/composer/Composer.tsx";
import { useConversionCache } from "@zakki/web/client/composer/conversion-cache.ts";
import { correctionsView } from "@zakki/web/client/db/live.ts";
import { useObservable } from "@zakki/web/client/hooks/use-observable.ts";
import { useBufferStore } from "@zakki/web/client/store/buffer.ts";
import { useGraphStore } from "@zakki/web/client/store/graph.ts";

/**
 * Composer の合成点: 現在のバッファ（親チャンク）と変換シード（corrections/cache）が
 * 揃ったら Composer を組み立てる。バッファ切替は key で丸ごと作り直す（store も張り直し）。
 *
 * corrections（学習）はローカル RxDB の correctionsView から（#44）。take(1) で初回値に
 * 凍結するのは、学習保存のたびに変換セッションを作り直さないため（セッション内の学習は
 * ConversionSession 自身が保持する）。cache はサーバ変換（anco）の付随キャッシュなので
 * サーバから読む（conversion-cache.ts。#26 で anco ごとクライアントへ移る予定）。
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
  const cache = useConversionCache();

  const corrections = useObservable<ReadonlyMap<string, string> | null>(
    useMemo(() => (db === null ? null : correctionsView(db).pipe(take(1))), [db]),
    null,
  );

  if (error !== null) {
    return <div className="empty-note">バッファ読み込みエラー: {error}</div>;
  }
  if (
    db === null ||
    currentId === null ||
    initialRaw === null ||
    corrections === null ||
    cache === null
  ) {
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
        corrections={corrections}
        conversionCache={cache}
      />
    </div>
  );
}
