import { PASTE_OPEN, pasteBlockEnd, stripPasteMarkers } from "@zakki/core/conversion/paste.ts";

export interface ChunkDraft {
  content: string;
}

const TITLE_MAX_LENGTH = 40;

// タイトル用の一文抽出にのみ使う（チャンク区切りには使わない）。
// 半角 . は "3.14" や URL を壊すため境界にしない。
const SENTENCE_BOUNDARY = /(?<=[。！？])/;

/** テキストを「ペースト領域外の改行」で分割した 1 行グループ */
export interface LineGroup {
  /** text 内の範囲 [start, end)。行区切りの改行そのものは含まない */
  start: number;
  end: number;
  /** マーカー除去・trim 済みの内容。空文字にはならない（呼び出し側で除外済み） */
  content: string;
}

/**
 * テキストを「ペースト領域外の改行」で行グループへ分割する共通プリミティブ。
 * チャンク化（chunkText）と records.ts の行グループ解決（editableBlockAt）は
 * どちらも同じ区切り規則に依存するため、ここに一本化する
 * （二重実装だと「チャンクと raw の 1:1」不変条件が実装間の一致に脆く依存する）。
 * 区切りは「ペースト領域の外にある改行」のみ（docs/CONCEPT.md §2）。
 * 句点では分割しない（Enter だけが投稿の区切り）。ペースト／凍結リテラル領域は
 * 内部に改行があっても分割せず、同一行の地の文とは 1 グループへマージする。
 * 内容が空（空行・マーカーのみ）のグループは含めない。
 */
export function scanLineGroups(text: string): LineGroup[] {
  const groups: LineGroup[] = [];
  let start = 0;
  let buf = "";
  const flush = (end: number) => {
    const content = buf.trim();
    buf = "";
    if (content !== "") {
      groups.push({ start, end, content });
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
      flush(i);
      start = i + 1;
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush(text.length);
  return groups;
}

/**
 * 変換済みテキストをチャンク（投稿単位）へ決定的に分割する。
 * 行グループ分割は scanLineGroups に委譲し、内容のみを採用する。
 */
export function chunkText(text: string): ChunkDraft[] {
  return scanLineGroups(text).map((group) => ({ content: group.content }));
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
