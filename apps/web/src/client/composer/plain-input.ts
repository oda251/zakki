import { liveTailStart } from "@zakki/core/entry/records.ts";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";

/**
 * かな漢字変換を OS の IME に返した web 版の入力補助（issue #149）。
 * 打鍵解釈（旧 applyPlainKey）は、入力欄がネイティブ textarea になり ASCII 打鍵が
 * その本文（draft）に載るようになったため不要になった。残るのは「改行で完結した
 * ライブ末尾を凍結リテラルへ畳む」だけ（docs/RECORDS.md のライブ末尾はローマ字
 * 打鍵ログではなく確定済みの素のテキスト）。
 */

/**
 * 末尾ライブ領域のうち、改行で完結した行を凍結リテラルへ畳む（変換なし版）。
 * core の freezeLiveTail と異なり settled 判定は不要（変換自体をしないため、
 * 改行に達した行は常に確定済み）。行区切りの改行はリテラルの外に残し、
 * 空行はそのまま温存する（docs/RECORDS.md）。
 */
export function freezePlainTail(raw: string): { raw: string; changed: boolean } {
  const start = liveTailStart(raw);
  const prefix = raw.slice(0, start);
  const live = raw.slice(start);

  const lastNewline = live.lastIndexOf("\n");
  if (lastNewline === -1) {
    return { raw, changed: false };
  }

  const committed = live.slice(0, lastNewline + 1);
  const remainder = live.slice(lastNewline + 1);
  const lines = committed.split("\n");
  lines.pop(); // 末尾の改行による空要素を落とす

  const frozen = `${lines.map((line) => (line.trim() === "" ? line : wrapPaste(line))).join("\n")}\n`;
  const next = prefix + frozen + remainder;
  return { raw: next, changed: next !== raw };
}