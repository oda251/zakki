import { okAsync, type ResultAsync } from "neverthrow";

export interface EngineError {
  readonly type: "engine-error";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * かな漢字変換エンジンの抽象（docs/FEATURES.md §変換エンジン）。
 * anco（AzooKeyKanaKanjiConverter）統合時に実装を差し替える。
 * 変換は非同期であり、タイピングをブロックしない（docs/CONCEPT.md §1 の不変条件）。
 */
export interface KanaKanjiEngine {
  readonly name: string;
  /**
   * かな文を漢字かな交じり文へ変換する。
   * @param leftContext 文脈ヒント（anco の `:ctx` に対応）
   */
  convert(kana: string, leftContext?: string): ResultAsync<string, EngineError>;
  /** 常駐プロセス等の後始末。identity 実装では何もしない */
  close(): void;
}

/**
 * フォールバックエンジン: 変換せずかなのまま返す。
 * anco 未統合（Swift toolchain 未導入）・エンジン停止時でも入力フローを成立させる。
 */
export const identityEngine: KanaKanjiEngine = {
  name: "identity",
  convert: (kana) => okAsync(kana),
  close: () => {},
};
