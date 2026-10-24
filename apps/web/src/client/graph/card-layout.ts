export const NODE_CARD_WIDTH = 64;
export const NODE_CARD_PADDING = 4;
export const NODE_CARD_FONT_SIZE = 10;
export const NODE_CARD_LINE_HEIGHT = 12;
export const NODE_CARD_MAX_GRAPHEMES = 36;
export const NODE_CARD_COLLISION_GAP = 4;

const NODE_CARD_BORDER = 1;
const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export interface CardLayout {
  lines: string[];
  width: number;
  height: number;
  collisionRadius: number;
}

export function cardLayout(text: string, measureText: (text: string) => number): CardLayout {
  const graphemes = Array.from(segmenter.segment(text), ({ segment }) => segment);
  const truncated = graphemes.length > NODE_CARD_MAX_GRAPHEMES;
  const displayText = graphemes.slice(0, NODE_CARD_MAX_GRAPHEMES).join("") + (truncated ? "…" : "");
  const lines: string[] = [];
  const maxLineWidth = NODE_CARD_WIDTH - NODE_CARD_PADDING * 2;

  for (const paragraph of displayText.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      const candidate = line + segment;
      if (line.length > 0 && measureText(candidate) > maxLineWidth) {
        lines.push(line);
        line = segment;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }

  const height =
    NODE_CARD_PADDING * 2 + NODE_CARD_BORDER * 2 + lines.length * NODE_CARD_LINE_HEIGHT;
  return {
    lines,
    width: NODE_CARD_WIDTH,
    height,
    collisionRadius: Math.hypot(NODE_CARD_WIDTH / 2, height / 2) + NODE_CARD_COLLISION_GAP,
  };
}
