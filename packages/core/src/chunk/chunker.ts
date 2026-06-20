import { PASTE_OPEN, pasteBlockEnd, stripPasteMarkers } from "@zakki/core/conversion/paste.ts";

export interface ChunkDraft {
  content: string;
}

const TITLE_MAX_LENGTH = 40;

// 一次区切り（docs/CONCEPT.md §2）: 改行・空行・句点による決定的分割。
// 句点は全角（。！？）のみを境界とする。半角 . は "3.14" や URL、
// 英単語パススルー後の英文ピリオドを壊すため境界にしない。
const SENTENCE_BOUNDARY = /(?<=[。！？])/;

interface Span {
  /** 元テキストの部分文字列（マーカー込み） */
  text: string;
  /** ペースト領域（原子チャンク）か */
  paste: boolean;
}

/**
 * テキストを「改行・句点」の一次区切りで分割する。ただしペースト領域
 * （PASTE_OPEN…PASTE_CLOSE）は内部を分割せず 1 スパンとして取り出す。
 * 各スパンは元テキストの部分文字列で、連結すると元に戻る（lossless）。
 */
function splitChunkSpans(text: string): Span[] {
  const spans: Span[] = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") {
      spans.push({ text: buf, paste: false });
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === PASTE_OPEN) {
      const end = pasteBlockEnd(text, i);
      flush();
      spans.push({ text: text.slice(i, end), paste: true });
      i = end;
      continue;
    }

    if (ch === "\n") {
      buf += ch;
      flush();
      i += 1;
      continue;
    }

    buf += ch;
    if (ch === "。" || ch === "！" || ch === "？") {
      flush();
    }
    i += 1;
  }
  flush();
  return spans;
}

/**
 * 変換済みテキストをチャンク（意味単位）へ決定的に分割する（句点・改行の一次区切り）。
 * ペースト／凍結リテラル領域は内部に句点・改行があっても 1 チャンクとして通す。
 */
export function chunkText(text: string): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const span of splitChunkSpans(text)) {
    if (span.paste) {
      const content = stripPasteMarkers(span.text).trim();
      if (content !== "") {
        drafts.push({ content });
      }
      continue;
    }
    for (const sentence of span.text.split(SENTENCE_BOUNDARY)) {
      const content = sentence.trim();
      if (content !== "") {
        drafts.push({ content });
      }
    }
  }
  return drafts;
}

/**
 * タイトルの決定的生成（Phase 1: チャンク先頭文の切り詰め）。
 * Phase 3 で lindera-wasm による抽出キーワードを付加する。
 */
export function makeTitle(content: string): string {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const sentence = firstLine.split(SENTENCE_BOUNDARY, 1)[0] ?? "";
  const base = sentence.trim();
  if (base.length <= TITLE_MAX_LENGTH) {
    return base;
  }
  return `${base.slice(0, TITLE_MAX_LENGTH)}…`;
}
