import { liveTailStart } from "@zakki/core/entry/records.ts";
import { deleteLastUnit } from "@zakki/core/romaji/convert.ts";
import { matchesAction } from "./keymap.ts";

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
 * 範囲選択は単一グローバルカーソル（applyCursorKey）が扱うため、ここでは
 * up/down/escape を none に倒す（旧 reveal/collapse は廃止）。
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
    case "backspace": {
      // 削除はライブ末尾（最後の凍結リテラル以降）に限る。ライブ末尾が空なら no-op で
      // 確定チャンク（凍結リテラル）を消さない。かな変換済みはかな単位、打鍵途中
      // ローマ字は 1 文字ずつ削る（仕様）。
      const tailStart = liveTailStart(raw);
      const tail = raw.slice(tailStart);
      return tail === ""
        ? { type: "none" }
        : { type: "edit", raw: raw.slice(0, tailStart) + deleteLastUnit(tail) };
    }
    case "return":
    case "enter":
      return { type: "edit", raw: `${raw}\n` };
    // 直前の変換単位の候補ローテーション（1 キー手動修正、docs/FEATURES.md §変換の修正 UX）
    case "tab":
      return { type: "rotate" };
    case "space":
      return { type: "edit", raw: `${raw} ` };
    // 上下・Esc はカーソル系（applyCursorKey）が扱うため、ここでは無視する
    case "up":
    case "pageup":
    case "down":
    case "pagedown":
    case "escape":
      return { type: "none" };
    default:
      break;
  }
  const ch = key.sequence;
  if (ch.length === 1 && isPrintable(ch)) {
    return { type: "edit", raw: raw + ch };
  }
  return { type: "none" };
}

// ── 単一グローバルカーソル（docs/PANES.md §3, §4） ───────────────────────────

export type PaneId = "main" | "related" | "detail";
export type CursorMode = "select" | "input";
export interface Cursor {
  pane: PaneId;
  index: number;
  mode: CursorMode;
}
/** 各ペインの要素数。main は View 数（New は index===main の追加要素）。 */
export interface ScreenLens {
  main: number;
  related: number;
  detail: number;
}
/** レンズ（メイン / 関連 / 詳細 の要素数）を組み立てる。導出を 1 箇所に寄せる */
export function screenLens(main: number, related: number, detail: number): ScreenLens {
  return { main, related, detail };
}
export type CursorIntent =
  | { type: "move"; cursor: Cursor }
  | { type: "edit-view"; pane: PaneId; index: number } // edit(e) on View → インライン編集を開く
  | { type: "delete-view"; pane: PaneId; index: number } // delete(d/Del) on View → 確認ダイアログ経由で削除
  | { type: "menu-view"; pane: PaneId; index: number } // select(Space/Enter) on View → メニューダイアログ
  | { type: "expand-digest"; index: number } // select on Digest → 詳細展開
  | { type: "close" } // cancel（select 時）
  | { type: "none" };

/** 確認ダイアログのキー解釈結果（docs/PANES.md §6） */
export type DialogAction = "confirm" | "cancel" | "none";

/**
 * 確認ダイアログのキー解釈（純粋関数, 意味アクションで統一）。
 * submit(Enter) / y → 確定、cancel(Esc) / n → 取消、それ以外 → 無視。
 * Ctrl/Meta 併用は none に倒す（ダイアログ表示中は exit を含む全キーを
 * App 側が握りつぶす前提）。
 */
export function applyDialogKey(key: KeyLike): DialogAction {
  if (key.ctrl || key.meta) {
    return "none";
  }
  if (matchesAction(key, "submit") || key.name === "y") {
    return "confirm";
  }
  if (matchesAction(key, "cancel") || key.name === "n") {
    return "cancel";
  }
  return "none";
}

/** メニューダイアログのキー解釈結果（docs/PANES.md §6） */
export type MenuAction =
  | { type: "move"; index: number }
  | { type: "choose" }
  | { type: "cancel" }
  | { type: "none" };

/**
 * メニューダイアログのキー解釈（純粋関数, 意味アクション）。
 * up → 前の項目（0 でクランプ）、down → 次の項目（count-1 でクランプ）、
 * select/submit → 決定、cancel → 取消、それ以外 → 無視。
 */
export function applyMenuKey(index: number, key: KeyLike, count: number): MenuAction {
  if (matchesAction(key, "up")) {
    return { type: "move", index: Math.max(0, index - 1) };
  }
  if (matchesAction(key, "down")) {
    return { type: "move", index: Math.min(Math.max(0, count - 1), index + 1) };
  }
  if (matchesAction(key, "select")) {
    return { type: "choose" };
  }
  if (matchesAction(key, "cancel")) {
    return { type: "cancel" };
  }
  return { type: "none" };
}

/** ペインの左右順（←→ で隣ペインへ移動するときの並び） */
const PANE_ORDER: readonly PaneId[] = ["main", "related", "detail"];

/** ペインの要素数を引く（main は New を含めないチャンク数＝lens.main） */
function paneCount(pane: PaneId, lens: ScreenLens): number {
  return pane === "main" ? lens.main : pane === "related" ? lens.related : lens.detail;
}

/** main の New を指すか（pane:"main" かつ index===lens.main） */
function isNew(cursor: Cursor, lens: ScreenLens): boolean {
  return cursor.pane === "main" && cursor.index === lens.main;
}

/**
 * select モードで隣ペインへ移動する。空ペイン（要素数 0、main は New があるので
 * 常に非空扱い）はスキップする。着地は対象ペインの index 0。移動先が無ければ null。
 */
function movePane(from: PaneId, dir: -1 | 1, lens: ScreenLens): Cursor | null {
  let i = PANE_ORDER.indexOf(from) + dir;
  for (; i >= 0 && i < PANE_ORDER.length; i += dir) {
    const pane = PANE_ORDER[i];
    if (pane === undefined) {
      break;
    }
    // main は New が常にあるため要素ゼロでも着地できる（New=input）。他は空ならスキップ
    if (pane === "main") {
      const mode: CursorMode = lens.main === 0 ? "input" : "select";
      return { pane, index: 0, mode };
    }
    if (paneCount(pane, lens) > 0) {
      return { pane, index: 0, mode: "select" };
    }
  }
  return null;
}

/**
 * 単一グローバルカーソルへのキー操作を解釈する（docs/PANES.md §4 の表に準拠）。
 * App 側はこの intent を見て setCursor / openEdit 等に振り分ける。
 */
export function applyCursorKey(cursor: Cursor, key: KeyLike, lens: ScreenLens): CursorIntent {
  if (cursor.mode === "input") {
    // New: ↑ で直上 View（select）へ。それ以外は App 側（applyKey/applyEditKey）に委ねる
    if (isNew(cursor, lens)) {
      if (key.name === "up" && lens.main > 0) {
        return {
          type: "move",
          cursor: { pane: "main", index: lens.main - 1, mode: "select" },
        };
      }
      return { type: "none" };
    }
    // Edit: 上下左右含めすべて App 側（applyEditKey）が扱う
    return { type: "none" };
  }
  // ── select モード（View / Digest を指す）。意味アクションで優先順に判定する ──
  const isView = cursor.pane === "main" || cursor.pane === "detail";
  // 1. move（↑↓＝チャンク移動 / ←→＝隣ペイン移動）
  if (matchesAction(key, "up")) {
    const index = Math.max(0, cursor.index - 1);
    return { type: "move", cursor: { ...cursor, index } };
  }
  if (matchesAction(key, "down")) {
    if (cursor.pane === "main") {
      // 末尾 View の下は New（input）。それ以外は次の View
      const index = cursor.index + 1;
      if (index === lens.main) {
        return { type: "move", cursor: { pane: "main", index: lens.main, mode: "input" } };
      }
      return { type: "move", cursor: { ...cursor, index } };
    }
    const count = paneCount(cursor.pane, lens);
    const index = Math.min(cursor.index + 1, Math.max(0, count - 1));
    return { type: "move", cursor: { ...cursor, index } };
  }
  if (matchesAction(key, "left")) {
    const next = movePane(cursor.pane, -1, lens);
    return next === null ? { type: "none" } : { type: "move", cursor: next };
  }
  if (matchesAction(key, "right")) {
    const next = movePane(cursor.pane, 1, lens);
    return next === null ? { type: "none" } : { type: "move", cursor: next };
  }
  // 2. edit(e) → View（main/detail）の Edit へ直行。related(Digest) は無効。
  if (matchesAction(key, "edit") && isView) {
    return { type: "edit-view", pane: cursor.pane, index: cursor.index };
  }
  // 3. delete(d/Del) → View の削除（確認ダイアログ経由）。related は無効。
  if (matchesAction(key, "delete") && isView) {
    return { type: "delete-view", pane: cursor.pane, index: cursor.index };
  }
  // 4. select(Space/Enter, submit を含む) → related は詳細展開、View はメニュー
  if (matchesAction(key, "select")) {
    if (cursor.pane === "related") {
      return { type: "expand-digest", index: cursor.index };
    }
    return { type: "menu-view", pane: cursor.pane, index: cursor.index };
  }
  // 5. cancel(Esc) → 閉じる
  if (matchesAction(key, "cancel")) {
    return { type: "close" };
  }
  // 6. その他は無視
  return { type: "none" };
}

/**
 * lens 変化後にカーソルを有効域へ補正する純粋関数。
 * - New を指していた（main,input,index>=main）なら index=lens.main（New 追従）。
 * - それ以外は index を各ペインの有効最大へクランプ。
 * - ペインが空（main 以外で要素 0、または main が空で select 指し）になったら
 *   main の New へフォールバック。
 */
export function clampCursor(cursor: Cursor, lens: ScreenLens): Cursor {
  // New 追従: input かつ main で末尾以降を指していたら常に New(=lens.main)
  if (cursor.pane === "main" && cursor.mode === "input" && cursor.index >= lens.main) {
    return { pane: "main", index: lens.main, mode: "input" };
  }
  const count = paneCount(cursor.pane, lens);
  if (count === 0) {
    // 空ペイン（select 指し）は main の New へフォールバック
    return { pane: "main", index: lens.main, mode: "input" };
  }
  const index = Math.min(Math.max(0, cursor.index), count - 1);
  return { ...cursor, index };
}

/**
 * 入力カーソルの補正（docs/PANES.md §3 の New 既定位置）。
 * 編集中でない main の input は常に末尾 New（index=lens.main）へ寄せ、文の確定で
 * チャンクが増減しても New が後ろのチャンクに取り残されないようにする。
 * それ以外（編集中・他ペイン・select）は clampCursor に委ねる。
 */
export function clampInputCursor(cursor: Cursor, lens: ScreenLens, editing: boolean): Cursor {
  if (!editing && cursor.pane === "main" && cursor.mode === "input") {
    return { pane: "main", index: lens.main, mode: "input" };
  }
  return clampCursor(cursor, lens);
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
