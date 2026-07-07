/**
 * 保存・解析のデバウンス間隔の SSOT（issue #56 で TUI / web の重複定義を統合）。
 */

/**
 * キーストローク単位の永続化（docs/CONCEPT.md）。打鍵停止後この時間で保存する。
 * TUI（apps/tui/src/tui/App.tsx）と web（apps/web/src/client/composer/Composer.tsx）が共有。
 */
export const SAVE_DEBOUNCE_MS = 300;

/**
 * 解析（タグ・関連・埋め込み）と vault への反映は保存より粗くてよい。
 * TUI の背景パス（App.tsx）と web サーバの AnalysisScheduler
 * （apps/web/src/server/analysis.ts）が共有する。スケジューラ実装そのものの
 * 統合（TUI 分割）は issue #53（M5）に委ねる。
 */
export const ANALYZE_DEBOUNCE_MS = 2000;
