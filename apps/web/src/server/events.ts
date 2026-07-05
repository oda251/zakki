/**
 * 解析完了イベントの pub/sub。AnalysisScheduler の完了フックが emit し、
 * GET /api/events (SSE) が購読者へ流す。クライアントはこれを合図に
 * グラフ・関連を再取得する（固定タイマーでのポーリングをしない）。
 */
export interface AnalysisEvents {
  /** @returns 購読解除関数（SSE 切断時に呼ぶ） */
  subscribe(listener: () => void): () => void;
  emit(): void;
}

export function createAnalysisEvents(): AnalysisEvents {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
