/**
 * 解析完了イベント（GET /api/events, SSE）の購読。
 * 再接続は EventSource の標準挙動に任せる。
 * @returns 購読解除関数（アンマウント時に呼ぶ）
 */
export function subscribeAnalysis(onAnalysis: () => void): () => void {
  const source = new EventSource("/api/events");
  source.addEventListener("analysis", onAnalysis);
  return () => source.close();
}
