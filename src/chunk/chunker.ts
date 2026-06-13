import { PASTE_CLOSE, PASTE_OPEN, stripPasteMarkers } from "@/conversion/paste.ts";

export interface ChunkDraft {
  title: string;
  content: string;
  /** ペースト由来など、句点・話題検出で分割／結合してはならない確定チャンク */
  atomic?: boolean;
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
      const close = text.indexOf(PASTE_CLOSE, i);
      const end = close === -1 ? text.length : close + 1;
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
 * 変換済みテキストをチャンク（意味単位の素案）へ決定的に分割する。
 * ペースト領域は内部に句点・改行があっても 1 つの atomic チャンクになる。
 * 二次区切り（話題転換検出）は src/entry/autosave.ts で本関数の結果を入力にとる。
 */
export function chunkText(text: string): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const span of splitChunkSpans(text)) {
    if (span.paste) {
      const content = stripPasteMarkers(span.text).trim();
      if (content !== "") {
        drafts.push({ title: makeTitle(content), content, atomic: true });
      }
      continue;
    }
    for (const sentence of span.text.split(SENTENCE_BOUNDARY)) {
      const content = sentence.trim();
      if (content !== "") {
        drafts.push({ title: makeTitle(content), content });
      }
    }
  }
  return drafts;
}

/**
 * 表示用に末尾 count チャンク分のテキストを返す（折りたたみ表示, App）。
 * ペースト領域は 1 チャンクとして数え、マーカーは除去する。
 */
export function displayTail(text: string, count: number): string {
  const spans = splitChunkSpans(text);
  const tail = count <= 0 ? spans : spans.slice(-count);
  return stripPasteMarkers(tail.map((s) => s.text).join(""));
}

/** 折りたたみ表示でめくれるチャンク（スパン）総数。表示数のクランプに使う */
export function countChunks(text: string): number {
  return splitChunkSpans(text).length;
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
