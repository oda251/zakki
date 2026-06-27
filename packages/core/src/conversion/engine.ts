import { okAsync, type ResultAsync } from "neverthrow";

export interface EngineError {
  readonly type: "engine-error";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * かな漢字変換エンジンの抽象（docs/FEATURES.md §変換エンジン）。
 * 変換は非同期であり、タイピングをブロックしない（docs/CONCEPT.md §1 の不変条件）。
 */
export interface KanaKanjiEngine {
  readonly name: string;
  /**
   * かな文の変換候補を良い順に返す（先頭が最良）。
   * 候補は手動修正 UX（候補ローテーション）にそのまま使う（docs/FEATURES.md §変換の修正 UX）。
   * @param leftContext 文脈ヒント（anco の `:ctx` に対応）
   */
  convert(kana: string, leftContext?: string): ResultAsync<string[], EngineError>;
  /** 常駐プロセス等の後始末。identity 実装では何もしない */
  close(): void;
}

/**
 * フォールバックエンジン: 変換せずかなのまま返す。
 * anco 未統合（バイナリ未導入）・エンジン停止時でも入力フローを成立させる。
 */
export const identityEngine: KanaKanjiEngine = {
  name: "identity",
  convert: (kana) => okAsync([kana]),
  close: () => {},
};
