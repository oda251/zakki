import { pipeline } from "@huggingface/transformers";

/**
 * ローカル embedding（docs/FEATURES.md §embedding）。
 * ruri-v3-30m の非公式 ONNX（q8 約37MB、256 次元）を transformers.js で実行する。
 * 出力一致は検証済み: q8 ≒ fp32、公式 PyTorch の参照類似度（0.954）を再現（2026-06-13）。
 * 意味類似にはプレフィックスなしの入力を使う（ruri-v3 の 1+3 プレフィックス方式）。
 */

export const EMBEDDING_MODEL = "sirasagi62/ruri-v3-30m-ONNX";
export const EMBEDDING_DIMS = 256;

export interface Embedder {
  readonly name: string;
  /** 正規化済み 256 次元ベクトルを返す。初回呼び出しでモデルを遅延ロードする */
  embed(texts: string[]): Promise<Float32Array[]>;
}

type FeatureExtractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

/**
 * 遅延ロードの ruri embedder。モデルロード（初回はダウンロード）は
 * 最初の embed() まで発生しないため、起動をブロックしない。
 */
export function createRuriEmbedder(): Embedder {
  let loading: Promise<FeatureExtractor> | null = null;
  const load = (): Promise<FeatureExtractor> => {
    loading ??= pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "q8",
    });
    return loading;
  };
  return {
    name: "ruri-v3-30m",
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      const extractor = await load();
      const output = await extractor(texts, {
        pooling: "mean",
        normalize: true,
      });
      return output.tolist().map((v) => Float32Array.from(v));
    },
  };
}

/** 正規化済みベクトル同士のコサイン類似度（= 内積） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}
