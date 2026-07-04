import type { KeyLike } from "@zakki/core/input/controller.ts";

/** toKeyLike が見る KeyboardEvent の部分（テストしやすいよう最小に絞る） */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  Backspace: "backspace",
  Enter: "enter",
  Tab: "tab",
  Escape: "escape",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  " ": "space",
};

/** ASCII 印字文字（0x20-0x7e）。ローマ字打鍵ログに入れてよい文字の範囲 */
function isAsciiPrintable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code <= 0x7e;
}

/**
 * KeyboardEvent → core の KeyLike（docs/COMPOSER.md のゲート）。
 * - IME 変換中（isComposing）は null（compositionend が凍結リテラルとして拾う）
 * - 単一文字は ASCII のみ通す（非 ASCII の直接入力は raw のローマ字模型に入れない）
 * - 対応しないキーは null（呼び出し側はブラウザ既定動作に任せる）
 */
export function toKeyLike(e: KeyEventLike): KeyLike | null {
  if (e.isComposing) return null;
  const named = NAMED_KEYS[e.key];
  if (named !== undefined) {
    return { name: named, sequence: e.key === " " ? " " : "", ctrl: e.ctrlKey, meta: e.metaKey };
  }
  if (e.key.length === 1 && isAsciiPrintable(e.key)) {
    return { name: e.key.toLowerCase(), sequence: e.key, ctrl: e.ctrlKey, meta: e.metaKey };
  }
  return null;
}
