import { PASTE_OPEN, pasteBlockEnd, stripPasteMarkers } from "@zakki/core/conversion/paste.ts";

export interface ChunkDraft {
  content: string;
}

const TITLE_MAX_LENGTH = 40;

// タイトル用の一文抽出にのみ使う（チャンク区切りには使わない）。
// 半角 . は "3.14" や URL を壊すため境界にしない。
const SENTENCE_BOUNDARY = /(?<=[。！？])/;

/**
 * 変換済みテキストをチャンク（投稿単位）へ決定的に分割する。
 * 区切りは「ペースト領域の外にある改行」のみ（docs/CONCEPT.md §2）。
 * 句点では分割しない（Enter だけが投稿の区切り）。ペースト／凍結リテラル領域は
 * 内部に改行があっても分割せず、同一行の地の文とは 1 チャンクへマージする。
 */
export function chunkText(text: string): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  let buf = "";
  const flush = () => {
    const content = buf.trim();
    buf = "";
    if (content !== "") {
      drafts.push({ content });
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === PASTE_OPEN) {
      const end = pasteBlockEnd(text, i);
      buf += stripPasteMarkers(text.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "\n") {
      flush();
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
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
