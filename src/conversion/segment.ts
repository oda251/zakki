import { PASTE_CLOSE, PASTE_OPEN } from "./paste.ts";

/**
 * かなストリームの変換単位への分割。
 * 境界はチャンク化（src/chunk/chunker.ts）と同じ「句点（。！？）・改行」。
 * ペースト領域（PASTE_OPEN…PASTE_CLOSE）は内部の句点・改行で分割せず、
 * 変換にもかけない 1 区切りとして扱う。
 * 全セグメントを連結すると元のテキストに一致する（lossless）。
 */
export interface KanaSegment {
  text: string;
  /**
   * true: 句点・改行で完結しており、かな漢字変換にかけてよい。
   * false: 末尾の入力途中セグメント。変換せずかなのまま表示する。
   */
  complete: boolean;
  /** 改行・ペースト領域など、変換対象にしない区切り */
  separator: boolean;
}

const SENTENCE_END = /[。！？]/;

export function segmentKana(kana: string): KanaSegment[] {
  const segments: KanaSegment[] = [];
  let current = "";
  const flushCurrent = (complete: boolean) => {
    if (current !== "") {
      segments.push({ text: current, complete, separator: false });
      current = "";
    }
  };

  let i = 0;
  while (i < kana.length) {
    const ch = kana.charAt(i);

    if (ch === PASTE_OPEN) {
      const close = kana.indexOf(PASTE_CLOSE, i);
      const end = close === -1 ? kana.length : close + 1;
      flushCurrent(true);
      // ペースト領域はそのまま通す（変換しない＝separator 扱い）
      segments.push({ text: kana.slice(i, end), complete: true, separator: true });
      i = end;
      continue;
    }

    if (ch === "\n") {
      flushCurrent(true);
      segments.push({ text: "\n", complete: true, separator: true });
      i += 1;
      continue;
    }

    current += ch;
    if (SENTENCE_END.test(ch)) {
      flushCurrent(true);
    }
    i += 1;
  }

  flushCurrent(false);
  return segments;
}
