export interface ChunkDraft {
  title: string;
  content: string;
}

const TITLE_MAX_LENGTH = 40;

// 一次区切り（docs/CONCEPT.md §2）: 改行・空行・句点による決定的分割。
// 句点は全角（。！？）のみを境界とする。半角 . は "3.14" や URL、
// 英単語パススルー後の英文ピリオドを壊すため境界にしない。
const SENTENCE_BOUNDARY = /(?<=[。！？])/;

/**
 * 変換済みテキストをチャンク（意味単位の素案）へ決定的に分割する。
 * 二次区切り（話題転換検出）は Phase 4 で導入し、本関数の結果を入力とする。
 */
export function chunkText(text: string): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const line of text.split("\n")) {
    for (const sentence of line.split(SENTENCE_BOUNDARY)) {
      const content = sentence.trim();
      if (content !== "") {
        drafts.push({ title: makeTitle(content), content });
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
