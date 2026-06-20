import type { KeyLike } from "./controller.ts";

/**
 * 意味アクション（docs/PANES.md §4）。生キーを直接解釈せず、いったん意味へ
 * 正規化してから文脈側が優先順に判定する。1 つのキーが複数アクションに
 * 該当してよい（例: Enter は submit かつ select）。
 */
export type Action =
  | "up"
  | "down"
  | "left"
  | "right"
  | "edit"
  | "delete"
  | "submit"
  | "select"
  | "cancel";

/**
 * 与えたキーがアクションに該当するか（純粋関数, docs/PANES.md §4 の表）。
 * - up/down/left/right: key.name 一致（修飾なし）。
 * - edit: e（Ctrl/Meta なし）。
 * - delete: d（Ctrl/Meta なし）または Delete。
 * - submit: Enter（return/enter）。
 * - select: Space または submit と同じ（return/enter）。
 * - cancel: Esc（escape）。
 */
export function matchesAction(key: KeyLike, action: Action): boolean {
  const plain = !key.ctrl && !key.meta;
  switch (action) {
    case "up":
    case "down":
    case "left":
    case "right":
      return key.name === action && plain;
    case "edit":
      return key.name === "e" && plain;
    case "delete":
      return (key.name === "d" && plain) || key.name === "delete";
    case "submit":
      return key.name === "return" || key.name === "enter";
    case "select":
      return key.name === "space" || key.name === "return" || key.name === "enter";
    case "cancel":
      return key.name === "escape";
    default:
      return false;
  }
}
