/**
 * チャンク表示のデザイン契約（docs/COMPOSER.md）。
 * 跨プラットフォームで共有するのは状態の「形」だけで、実値は持たない
 * （TUI は opentui style、web は CSS 意味クラス名。cell と px で別物のため共有しない）。
 */
export interface ChunkPresentation<Style> {
  base: Style;
  selected: Style;
  pending: Style;
}
