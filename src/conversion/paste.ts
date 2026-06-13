/**
 * ペースト塊を「内部の句点・改行で分割しない 1 チャンク」として扱うための
 * マーカー（docs/CONCEPT.md §2 への追補）。raw（source of truth）に
 * PASTE_OPEN … PASTE_CLOSE で囲んで埋め込み、convertRomaji は領域を素通しし、
 * チャンク化・表示の各段でマーカーを解釈／除去する。私用領域（PUA）を使う。
 */
export const PASTE_OPEN = String.fromCharCode(0xe000);
export const PASTE_CLOSE = String.fromCharCode(0xe001);

/** ペースト本文をマーカーで囲む。本文中の既存マーカー・制御文字は除去する */
export function wrapPaste(text: string): string {
  return PASTE_OPEN + sanitizePaste(text) + PASTE_CLOSE;
}

/** 表示・保存前にマーカーを取り除く */
export function stripPasteMarkers(text: string): string {
  return text.replaceAll(PASTE_OPEN, "").replaceAll(PASTE_CLOSE, "");
}

/** マーカー・CR・その他 C0 制御文字を除去する（改行・タブは温存） */
function sanitizePaste(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === PASTE_OPEN || ch === PASTE_CLOSE || ch === "\r") {
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && ch !== "\n" && ch !== "\t") {
      continue;
    }
    out += ch;
  }
  return out;
}
