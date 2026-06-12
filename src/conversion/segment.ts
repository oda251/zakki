/**
 * かなストリームの変換単位への分割。
 * 境界はチャンク化（src/chunk/chunker.ts）と同じ「句点（。！？）・改行」。
 * 全セグメントを連結すると元のテキストに一致する（lossless）。
 */
export interface KanaSegment {
  text: string;
  /**
   * true: 句点・改行で完結しており、かな漢字変換にかけてよい。
   * false: 末尾の入力途中セグメント。変換せずかなのまま表示する。
   */
  complete: boolean;
  /** 改行などの区切り文字そのもの。変換対象にしない */
  separator: boolean;
}

const SENTENCE_END = /[。！？]/;

export function segmentKana(kana: string): KanaSegment[] {
  const segments: KanaSegment[] = [];
  let current = "";
  for (const ch of kana) {
    if (ch === "\n") {
      if (current !== "") {
        segments.push({ text: current, complete: true, separator: false });
        current = "";
      }
      segments.push({ text: "\n", complete: true, separator: true });
      continue;
    }
    current += ch;
    if (SENTENCE_END.test(ch)) {
      segments.push({ text: current, complete: true, separator: false });
      current = "";
    }
  }
  if (current !== "") {
    segments.push({ text: current, complete: false, separator: false });
  }
  return segments;
}
