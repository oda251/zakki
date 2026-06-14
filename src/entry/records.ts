import {
  PASTE_CLOSE,
  PASTE_OPEN,
  pasteBlockEnd,
  stripPasteMarkers,
  wrapPaste,
} from "@/conversion/paste.ts";
import { convertRomaji } from "@/romaji/convert.ts";

/**
 * 記録モデル（docs/RECORDS.md）。確定したチャンクは raw 内に「凍結リテラル」
 * （ペースト機構の PUA マーカー）として埋め込む。リテラルは変換されず素通し
 * されるため、確定後は再変換されない（誤変換の手動修正がそのまま固定される）。
 * 末尾のライブ領域（最後のリテラル以降のローマ字）だけが変換・候補の対象。
 */

/** raw を凍結リテラル領域とライブ（ローマ字）領域へ順に分解する */
export interface RawBlock {
  /** raw 内の範囲 [start, end) */
  start: number;
  end: number;
  /** 凍結リテラルか（false はライブのローマ字） */
  frozen: boolean;
  /** frozen: 確定テキスト（マーカー除去済み） / live: ローマ字そのまま */
  text: string;
}

export function parseBlocks(raw: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  let i = 0;
  while (i < raw.length) {
    const open = raw.indexOf(PASTE_OPEN, i);
    if (open === -1) {
      blocks.push({ start: i, end: raw.length, frozen: false, text: raw.slice(i) });
      break;
    }
    if (open > i) {
      blocks.push({ start: i, end: open, frozen: false, text: raw.slice(i, open) });
    }
    const end = pasteBlockEnd(raw, open);
    blocks.push({ start: open, end, frozen: true, text: stripPasteMarkers(raw.slice(open, end)) });
    i = end;
  }
  return blocks;
}

/** raw 内の確定（凍結）チャンク数（折りたたみ表示のクランプに使う） */
export function frozenCount(raw: string): number {
  return parseBlocks(raw).filter((b) => b.frozen).length;
}

/** 末尾のライブ領域（最後のリテラル以降）の開始位置 */
export function liveTailStart(raw: string): number {
  const close = raw.lastIndexOf(PASTE_CLOSE);
  return close === -1 ? 0 : close + 1;
}

/** raw 内のリテラル領域 [start, end) を確定テキストで置換する（空なら削除）。修正の確定に使う */
export function replaceBlock(raw: string, start: number, end: number, text: string): string {
  const before = raw.slice(0, start);
  const after = raw.slice(end);
  return text === "" ? before + after : before + wrapPaste(text) + after;
}

/**
 * raw の position 番目の凍結リテラル領域を返す（無ければ null）。
 * 不変条件「凍結リテラルは chunks.position 順で 1:1」（docs/PANES.md 実装リスク2）
 * により、過去/当日チャンクの編集対象領域をマッピングする。末尾の未凍結ライブ文
 * （position >= 凍結数）は対象外で null を返す（メインで編集に委ねる）。
 */
export function frozenBlockAt(raw: string, position: number): RawBlock | null {
  return parseBlocks(raw).filter((b) => b.frozen)[position] ?? null;
}

const SENTENCE_BOUNDARY = /[。！？\n]/u;

/**
 * ローマ字の先頭1文（最初の句点・改行境界まで）のローマ字長を返す。
 * 境界が無ければ null（＝まだ末尾の入力途中チャンクのみ）。
 */
export function firstSentenceRomajiLen(romaji: string): number | null {
  const { converted } = convertRomaji(romaji);
  const m = converted.match(SENTENCE_BOUNDARY);
  if (m === null || m.index === undefined) {
    return null;
  }
  const need = m.index + 1; // 境界文字を含める
  for (let r = 1; r <= romaji.length; r++) {
    if (convertRomaji(romaji.slice(0, r)).converted.length >= need) {
      return r;
    }
  }
  return romaji.length;
}

/** 1文ぶんのローマ字を確定テキストへ変換し、変換が settled かを返す関数の型 */
export type SettledConvert = (sentenceRomaji: string) => { text: string; settled: boolean };

/**
 * 末尾ライブ領域のうち「最後の1文を除く」完結済み・変換済みの文を凍結リテラルへ畳む
 * （確定境界＝末尾の入力中チャンク以外, docs/RECORDS.md）。
 * 変換が未完（settled でない）の文に達したら、そこで止めて次回に委ねる。
 */
export function freezeLiveTail(
  raw: string,
  convert: SettledConvert,
): { raw: string; changed: boolean } {
  const start = liveTailStart(raw);
  let prefix = raw.slice(0, start);
  let live = raw.slice(start);
  let changed = false;

  while (true) {
    const len = firstSentenceRomajiLen(live);
    if (len === null) {
      break; // 境界なし＝末尾チャンクのみ
    }
    const rest = live.slice(len);
    const { text, settled } = convert(live.slice(0, len));
    // Enter（改行）で終えた文は最後でも確定する。改行は文（句点 split で text 側）にも
    // rest 側（「文。」の直後で Enter）にも現れうるので両方を見る。句点だけで終わる
    // 最後の文は書き足す余地があるためライブのまま残す（末尾以外確定 + Enter で即確定）。
    const hasNewline = text.endsWith("\n") || rest.includes("\n");
    if (rest.trim() === "" && !hasNewline) {
      break;
    }
    if (!settled) {
      break; // 未変換は畳まず次回へ
    }
    // 末尾の改行は区切りとして捨て、句点等は確定テキストに残す
    const frozen = text.replace(/\n+$/u, "");
    if (frozen.trim() !== "") {
      prefix += wrapPaste(frozen);
    }
    live = rest;
    changed = true;
  }

  return { raw: prefix + live, changed };
}
