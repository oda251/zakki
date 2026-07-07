import { useCallback, useState } from "react";
import type { Cursor } from "@zakki/core/input/controller.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { ChunkWithDate } from "@zakki/data/chunk/queries.ts";
import { getChunkContext } from "@zakki/data/chunk/queries.ts";

/** 関連を展開したとき、当該チャンクの前後に何件ずつ並べるか */
const CONTEXT_RADIUS = 1;

/**
 * 詳細ペイン（関連の展開）の状態と配線（issue #57 で App.tsx から切り出し）。
 */
export function useDetailPane(options: {
  db: Db;
  moveCursor: (cursor: Cursor) => void;
  onMessage: (message: string) => void;
}) {
  const { db, moveCursor, onMessage } = options;
  // 関連項目をクリックすると、その投稿の前後を右パネルに展開する（null で一覧表示）
  const [expandedChunkId, setExpandedChunkId] = useState<number | null>(null);
  // 展開中の「当該チャンク＋前後」。クリック時に getChunkContext で取得して保持する
  const [contextChunks, setContextChunks] = useState<ChunkWithDate[]>([]);

  /** 関連の詳細を閉じる（一覧表示へ戻す） */
  const closeExpand = useCallback(() => {
    setExpandedChunkId(null);
    setContextChunks([]);
  }, []);

  /**
   * 関連項目クリック / Digest 起動: その投稿＋前後を取得して詳細ペインに展開し、
   * カーソルを詳細ペインの当該チャンクへ移送する（docs/PANES.md §5 4a, §7 初期位置）。
   */
  const openExpand = useCallback(
    (chunkId: number) => {
      void getChunkContext(db, chunkId, CONTEXT_RADIUS).match(
        (ctx) => {
          setExpandedChunkId(chunkId);
          setContextChunks(ctx);
          // 詳細内の当該チャンク index にカーソルを移す（無ければ 0）
          const idx = ctx.findIndex((c) => c.id === chunkId);
          moveCursor({ pane: "detail", index: idx < 0 ? 0 : idx, mode: "select" });
        },
        (e) => onMessage(`関連: ${e.message}`),
      );
    },
    [db, moveCursor, onMessage],
  );

  /** 表示中の詳細を最新へ更新する（編集確定後の再取得。失敗は無視して表示を保つ） */
  const refreshContext = useCallback(
    (chunkId: number) => {
      void getChunkContext(db, chunkId, CONTEXT_RADIUS).match(
        (ctx) => setContextChunks(ctx),
        () => {},
      );
    },
    [db],
  );

  return { expandedChunkId, contextChunks, openExpand, closeExpand, refreshContext };
}
