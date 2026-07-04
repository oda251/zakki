/** グラフノードラベルの既定 clamp 長（コードポイント数） */
export const NODE_LABEL_MAX = 12;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

/**
 * ノードラベル用の本文 clamp。改行を空白 1 個に畳んでから、書記素単位で
 * max 文字に切り詰めて ellipsis を付ける（サロゲートペア・結合文字を壊さない）。
 */
export function clampText(text: string, max: number = NODE_LABEL_MAX): string {
  const flat = text.replaceAll(/\n+/gu, " ");
  const graphemes = Array.from(segmenter.segment(flat), (s) => s.segment);
  if (graphemes.length <= max) {
    return flat;
  }
  return `${graphemes.slice(0, max).join("")}…`;
}
