import { convertRomaji } from "@/romaji/convert.ts";

/** useKeyboard の KeyEvent から必要な部分だけを切り出した形 */
export interface KeyLike {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
}

export type KeyAction = { type: "edit"; raw: string } | { type: "exit" } | { type: "none" };

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
  if (key.ctrl || key.meta) {
    return { type: "none" };
  }
  switch (key.name) {
    case "backspace":
      return raw === "" ? { type: "none" } : { type: "edit", raw: raw.slice(0, -1) };
    case "return":
    case "enter":
      return { type: "edit", raw: `${raw}\n` };
    case "space":
      return { type: "edit", raw: `${raw} ` };
    default:
      break;
  }
  const ch = key.sequence;
  if (ch.length === 1 && isPrintable(ch)) {
    return { type: "edit", raw: raw + ch };
  }
  return { type: "none" };
}

export interface DisplayState {
  /** 確定済みのかな交じりテキスト */
  converted: string;
  /** 打鍵途中のローマ字（薄く表示する） */
  pending: string;
}

/** raw から画面表示を導出する。raw が source of truth（再計算で常に一致） */
export function deriveDisplay(raw: string): DisplayState {
  const { converted, pending } = convertRomaji(raw);
  return { converted, pending };
}

/**
 * 永続化用スナップショットを raw から導出する。
 * flush は終了時のみ true（打鍵途中の n を ん として確定させる）。
 * 自動保存中は false にして、未確定ローマ字を converted に混ぜない。
 */
export function snapshotFromRaw(
  date: string,
  raw: string,
  options: { flush?: boolean } = {},
): { date: string; raw: string; converted: string } {
  const { converted } = convertRomaji(raw, { flush: options.flush ?? false });
  return { date, raw, converted };
}
