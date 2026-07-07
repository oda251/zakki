import { pipeline } from "@huggingface/transformers";
import type { Embedder } from "@zakki/core/embedding/types.ts";

/**
 * ローカル embedding（docs/FEATURES.md §embedding）。
 * ruri-v3-30m の非公式 ONNX（q8 約37MB、256 次元）を transformers.js で実行する。
 * 出力一致は検証済み: q8 ≒ fp32、公式 PyTorch の参照類似度（0.954）を再現（2026-06-13）。
 * 意味類似にはプレフィックスなしの入力を使う（ruri-v3 の 1+3 プレフィックス方式）。
 */

/** DB（embeddings.model 列）へ永続化する embedder 名（data/embedding/store.ts が保存する） */
export const EMBEDDING_MODEL_NAME = "ruri-v3-30m";

/** transformers.js へ渡す Hugging Face 上のモデル識別子（{@link EMBEDDING_MODEL_NAME} の非公式 ONNX 版） */
export const EMBEDDING_MODEL = `sirasagi62/${EMBEDDING_MODEL_NAME}-ONNX`;

/**
 * このモデルの出力次元。実行時のベクトル復元は buffer 長から次元を導く
 * （data/embedding/vector.ts）ため、これはモデル契約の検証用
 * （warmup / 統合テスト）にのみ使う。
 */
export const EMBEDDING_DIMS = 256;

type FeatureExtractor = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

/**
 * 遅延ロードの ruri embedder。モデルロード（初回はダウンロード）は
 * 最初の embed() まで発生しないため、起動をブロックしない。
 */
/**
 * 環境からの embedder 解決（TUI / web サーバの合成点が共有）。
 * noEmbedding（ZAKKI_NO_EMBEDDING=1 由来）なら null
 * （関連・セマンティック機能を無効化し完全決定的動作）。
 */
export function resolveDefaultEmbedder(noEmbedding: boolean): Embedder | null {
  return noEmbedding ? null : createRuriEmbedder();
}

export function createRuriEmbedder(): Embedder {
  let loading: Promise<FeatureExtractor> | null = null;
  const load = (): Promise<FeatureExtractor> => {
    loading ??= pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "q8",
    });
    return loading;
  };
  return {
    name: EMBEDDING_MODEL_NAME,
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
