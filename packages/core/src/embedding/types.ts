export interface Embedder {
  readonly name: string;
  /**
   * 正規化済みベクトルを返す。初回呼び出しでモデルを遅延ロードする。
   * 次元は実装のモデルが決める（ruri は 256 —
   * packages/backend/src/embedding/embedder.ts の EMBEDDING_DIMS）。
   */
  embed(texts: string[]): Promise<Float32Array[]>;
}
