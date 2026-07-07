/**
 * 保存・解析のデバウンス間隔の SSOT（issue #56 で TUI / web の重複定義を統合）。
 */

/**
 * キーストローク単位の永続化（docs/CONCEPT.md）。打鍵停止後この時間で保存する。
 * TUI（apps/tui/src/tui/use-save-pipeline.ts）と web
 * （apps/web/src/client/composer/Composer.tsx）が共有。
 */
export const SAVE_DEBOUNCE_MS = 300;

/**
 * 解析（タグ・関連・埋め込み）と vault への反映は保存より粗くてよい。
 * AnalysisScheduler（packages/backend/src/analysis/scheduler.ts）の既定デバウンス間隔
 * （issue #57 でスケジューラ実装ごと backend に一本化）。
 */
export const ANALYZE_DEBOUNCE_MS = 2000;
