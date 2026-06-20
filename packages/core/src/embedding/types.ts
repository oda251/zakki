export const EMBEDDING_DIMS = 256;

export interface Embedder {
  readonly name: string;
  /** 正規化済み 256 次元ベクトルを返す。初回呼び出しでモデルを遅延ロードする */
  embed(texts: string[]): Promise<Float32Array[]>;
}
