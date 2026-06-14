import { deleteLastUnit } from "@/romaji/convert.ts";

/** useKeyboard の KeyEvent から必要な部分だけを切り出した形 */
export interface KeyLike {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
}

export type KeyAction =
  | { type: "edit"; raw: string }
  | { type: "rotate" }
  | { type: "open-search" }
  | { type: "reveal-older" }
  | { type: "reveal-newer" }
  | { type: "collapse" }
  | { type: "exit" }
  | { type: "none" };

export type SearchAction = { type: "edit"; query: string } | { type: "close" } | { type: "none" };

/** C0 制御文字（0x00-0x1f）と DEL（0x7f）以外を印字可能とみなす */
function isPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code > 0x1f && code !== 0x7f;
}

/**
 * キーイベントを raw（ローマ字入力ログ）への操作に解釈する。
 * 編集モデルは追記専用（末尾への入力と backspace のみ）。カーソル移動・
 * 範囲選択は「考えを入力する以外の操作」にあたるため Phase 1 では持たない。
 */
export function applyKey(raw: string, key: KeyLike): KeyAction {
  if (key.ctrl && (key.name === "c" || key.name === "d")) {
    return { type: "exit" };
  }
  // Ctrl+F: インクリメンタル全文検索ペイン（docs/FEATURES.md 候補7）
  if (key.ctrl && key.name === "f") {
    return { type: "open-search" };
  }
  if (key.ctrl || key.meta) {
    return { type: "none" };
  }
  switch (key.name) {
    case "backspace":
      // かな変換済みはかな単位、打鍵途中ローマ字は 1 文字ずつ削る（仕様）
      return raw === "" ? { type: "none" } : { type: "edit", raw: deleteLastUnit(raw) };
    case "return":
    case "enter":
      return { type: "edit", raw: `${raw}\n` };
    // 直前の変換単位の候補ローテーション（1 キー手動修正、docs/FEATURES.md §変換の修正 UX）
    case "tab":
      return { type: "rotate" };
    case "space":
      return { type: "edit", raw: `${raw} ` };
    // 折りたたみ表示の履歴めくり（既定は最新＋入力中チャンク。1 回で 1 チャンクずつ）
    case "up":
    case "pageup":
      return { type: "reveal-older" };
    case "down":
    case "pagedown":
      return { type: "reveal-newer" };
    case "escape":
      return { type: "collapse" };
    default:
      break;
  }
  const ch = key.sequence;
  if (ch.length === 1 && isPrintable(ch)) {
    return { type: "edit", raw: raw + ch };
  }
  return { type: "none" };
}

/** 修正モードのプレーンテキスト編集状態（カーソル付き, docs/RECORDS.md） */
export interface CursorState {
  /** 編集中のプレーンテキスト（かな変換しない。打った文字がそのまま入る） */
  text: string;
  /** カーソル位置 [0, text.length]（cursor 文字目の手前） */
  cursor: number;
}

/**
 * 修正モードのキー操作（プレーンテキスト＋可動カーソル）。
 * かな漢字変換はしない: 打鍵はそのまま挿入される（文単位の非同期変換は
 * バッファ途中のインライン変換ができないため、修正時は素のテキスト編集とする）。
 * Esc/Enter/Ctrl+C は App 側で処理するためここでは扱わない。
 */
export function applyEditKey(state: CursorState, key: KeyLike): CursorState {
  if (key.ctrl || key.meta) {
    return state;
  }
  const { text, cursor } = state;
  switch (key.name) {
    case "left":
      return { text, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { text, cursor: Math.min(text.length, cursor + 1) };
    case "home":
      return { text, cursor: 0 };
    case "end":
      return { text, cursor: text.length };
    case "backspace":
      return cursor === 0
        ? state
        : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    case "delete":
      return cursor >= text.length
        ? state
        : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    case "space":
      return { text: `${text.slice(0, cursor)} ${text.slice(cursor)}`, cursor: cursor + 1 };
    default:
      break;
  }
  const ch = key.sequence;
  if (ch.length === 1 && isPrintable(ch)) {
    return { text: text.slice(0, cursor) + ch + text.slice(cursor), cursor: cursor + 1 };
  }
  return state;
}

/** 検索モードのキー解釈。クエリはローマ字のまま保持し、表示・照合時にかなへ変換する */
export function applySearchKey(query: string, key: KeyLike): SearchAction {
  if (key.name === "escape" || (key.ctrl && (key.name === "f" || key.name === "c"))) {
    return { type: "close" };
  }
  if (key.ctrl || key.meta) {
    return { type: "none" };
  }
  switch (key.name) {
    case "backspace":
      return query === "" ? { type: "none" } : { type: "edit", query: query.slice(0, -1) };
    case "space":
      return { type: "edit", query: `${query} ` };
    default:
      break;
  }
  const ch = key.sequence;
  if (ch.length === 1 && isPrintable(ch)) {
    return { type: "edit", query: query + ch };
  }
  return { type: "none" };
}
