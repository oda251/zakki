import { scanLineGroups } from "@zakki/core/chunk/chunker.ts";
import {
  PASTE_CLOSE,
  PASTE_OPEN,
  pasteBlockEnd,
  stripPasteMarkers,
  wrapPaste,
} from "@zakki/core/conversion/paste.ts";
import { convertRomaji } from "@zakki/core/romaji/convert.ts";

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

/**
 * 末尾のライブ領域の開始位置。最後のリテラル直後の改行（行区切り）は
 * 確定済み領域に属するため飛ばす（ライブ領域＝現在入力中の行以降）。
 */
export function liveTailStart(raw: string): number {
  const close = raw.lastIndexOf(PASTE_CLOSE);
  let start = close === -1 ? 0 : close + 1;
  while (start < raw.length && raw.charAt(start) === "\n") {
    start += 1;
  }
  return start;
}

/** raw 内のリテラル領域 [start, end) を確定テキストで置換する（空なら削除）。修正の確定に使う */
export function replaceBlock(raw: string, start: number, end: number, text: string): string {
  const before = raw.slice(0, start);
  const after = raw.slice(end);
  return text === "" ? before + after : before + wrapPaste(text) + after;
}

/** 編集対象として解決した raw 内のチャンク領域（docs/PANES.md §7） */
export interface EditableBlock {
  /** raw 内の範囲 [start, end) */
  start: number;
  end: number;
  /** 凍結リテラルか（false は末尾ライブ文＝確定時に literal へ畳む） */
  frozen: boolean;
  /** frozen: リテラル本文（編集の初期値）。live: 空（初期値は呼び出し側が DB content から渡す） */
  text: string;
}

/**
 * raw の position 番目のチャンクの編集対象領域を返す（無ければ null）。
 * 不変条件「チャンクは raw の順序と 1:1」（docs/PANES.md 実装リスク2）は
 * 行グループ（＝チャンク区切り、scanLineGroups で chunker.ts と共通化）で
 * 成立させる。行全体が単一の凍結リテラルなら frozen（初期値＝リテラル本文）、
 * ローマ字やリテラル混在の行は live 扱い（初期値は呼び出し側が DB content から渡す）。
 */
export function editableBlockAt(raw: string, position: number): EditableBlock | null {
  const group = scanLineGroups(raw)[position];
  if (group === undefined) {
    return null;
  }
  const blocks = parseBlocks(raw.slice(group.start, group.end));
  const frozen = blocks.filter((b) => b.frozen);
  const literalOnly = frozen.length === 1 && blocks.every((b) => b.frozen || b.text.trim() === "");
  if (literalOnly && frozen[0] !== undefined) {
    return { start: group.start, end: group.end, frozen: true, text: frozen[0].text };
  }
  return { start: group.start, end: group.end, frozen: false, text: "" };
}

const LINE_BOUNDARY = /\n/u;

/**
 * ローマ字の先頭1行（最初の改行境界まで）のローマ字長を返す。
 * 境界が無ければ null（＝まだ末尾の入力途中行のみ）。連続した改行（空行）は
 * 末尾までまとめて 1 行分に含める（孤立した区切りを残さない）。
 */
export function firstLineRomajiLen(romaji: string): number | null {
  const { converted } = convertRomaji(romaji);
  const m = converted.match(LINE_BOUNDARY);
  if (m === null || m.index === undefined) {
    return null;
  }
  const need = m.index + 1; // 境界文字を含める
  for (let r = 1; r <= romaji.length; r++) {
    if (convertRomaji(romaji.slice(0, r)).converted.length >= need) {
      // 連続する改行（空行）は末尾まで食い切る
      let end = r;
      while (end < romaji.length && romaji.charAt(end) === "\n") {
        end += 1;
      }
      return end;
    }
  }
  return romaji.length;
}

/** 1行ぶんのローマ字を確定テキストへ変換し、変換が settled かを返す関数の型 */
export type SettledConvert = (lineRomaji: string) => { text: string; settled: boolean };

/**
 * 末尾ライブ領域のうち、Enter（改行）で完結し変換も済んだ行を凍結リテラルへ畳む
 * （確定境界＝改行のみ, docs/RECORDS.md）。句点では畳まない（Enter だけが投稿の区切り）。
 * 行区切りの改行はリテラルの外に残す（chunkText がチャンク境界として解釈する）。
 * 変換が未完（settled でない）の行に達したら、そこで止めて次回に委ねる。
 */
export function freezeLiveTail(
  raw: string,
  convert: SettledConvert,
): { raw: string; changed: boolean } {
  const start = liveTailStart(raw);
  let prefix = raw.slice(0, start);
  let live = raw.slice(start);

  while (true) {
    const len = firstLineRomajiLen(live);
    if (len === null) {
      break; // 改行なし＝末尾の入力中行のみ
    }
    const { text, settled } = convert(live.slice(0, len));
    if (!settled) {
      break; // 未変換は畳まず次回へ
    }
    // 行区切りの改行は区切りとしてリテラルの外へ（空行はそのまま温存）
    const newlines = /\n+$/u.exec(text)?.[0] ?? "\n";
    const frozen = text.replace(/\n+$/u, "");
    prefix += (frozen.trim() === "" ? "" : wrapPaste(frozen)) + newlines;
    live = live.slice(len);
  }

  const next = prefix + live;
  return { raw: next, changed: next !== raw };
}
