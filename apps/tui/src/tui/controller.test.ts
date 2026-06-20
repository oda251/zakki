import { describe, expect, test } from "bun:test";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import type { Cursor, CursorState, KeyLike, ScreenLens } from "./controller.ts";
import {
  applyCursorKey,
  applyDialogKey,
  applyEditKey,
  applyKey,
  applyMenuKey,
  clampCursor,
} from "./controller.ts";

function key(partial: Partial<KeyLike> & { name: string }): KeyLike {
  return { sequence: "", ctrl: false, meta: false, ...partial };
}

const st = (text: string, cursor: number): CursorState => ({ text, cursor });

describe("applyKey", () => {
  test("印字可能文字を末尾に追記する", () => {
    expect(applyKey("ka", key({ name: "k", sequence: "k" }))).toEqual({
      type: "edit",
      raw: "kak",
    });
  });

  test("大文字（shift 入力）も追記する", () => {
    expect(applyKey("", key({ name: "c", sequence: "C" }))).toEqual({
      type: "edit",
      raw: "C",
    });
  });

  test("backspace は確定かなをかな単位で、打鍵途中ローマ字は 1 文字で削る", () => {
    // 確定かな か(=ka) はローマ字スパンごと削除
    expect(applyKey("ka", key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: "",
    });
    // 拗音 きゃ(=kya) も 1 単位
    expect(applyKey("kya", key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: "",
    });
    // 打鍵途中ローマ字（pending）は 1 文字だけ
    expect(applyKey("kak", key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: "ka",
    });
    expect(applyKey("", key({ name: "backspace" }))).toEqual({ type: "none" });
  });

  test("確定リテラルの後ろでライブ末尾が空なら backspace は no-op（確定チャンクを消さない）", () => {
    // 凍結リテラルのみ＝ライブ末尾が空。ここで backspace しても確定は削らない
    const raw = wrapPaste("かくてい");
    expect(applyKey(raw, key({ name: "backspace" }))).toEqual({ type: "none" });
  });

  test("確定リテラルの後ろのライブ末尾だけを backspace で削る（確定は保つ）", () => {
    const raw = `${wrapPaste("かくてい")}ka`;
    expect(applyKey(raw, key({ name: "backspace" }))).toEqual({
      type: "edit",
      raw: wrapPaste("かくてい"),
    });
  });

  test("return / space を追記する", () => {
    expect(applyKey("a", key({ name: "return" }))).toEqual({
      type: "edit",
      raw: "a\n",
    });
    expect(applyKey("a", key({ name: "space", sequence: " " }))).toEqual({
      type: "edit",
      raw: "a ",
    });
  });

  test("Ctrl+C / Ctrl+D で終了する", () => {
    expect(applyKey("a", key({ name: "c", ctrl: true }))).toEqual({
      type: "exit",
    });
    expect(applyKey("a", key({ name: "d", ctrl: true }))).toEqual({
      type: "exit",
    });
  });

  test("上下・Esc はカーソル系に委ねるため none を返す", () => {
    expect(applyKey("a", key({ name: "up", sequence: "\x1b[A" }))).toEqual({ type: "none" });
    expect(applyKey("a", key({ name: "down", sequence: "\x1b[B" }))).toEqual({ type: "none" });
    expect(applyKey("a", key({ name: "pageup" }))).toEqual({ type: "none" });
    expect(applyKey("a", key({ name: "pagedown" }))).toEqual({ type: "none" });
    expect(applyKey("a", key({ name: "escape" }))).toEqual({ type: "none" });
  });

  test("その他の修飾キー・制御シーケンスは無視する", () => {
    expect(applyKey("a", key({ name: "f1", sequence: "OP" }))).toEqual({
      type: "none",
    });
    expect(applyKey("a", key({ name: "s", sequence: "s", meta: true }))).toEqual({ type: "none" });
  });
});

describe("applyEditKey", () => {
  test("左右キーでカーソルを移動し、両端でクランプする", () => {
    expect(applyEditKey(st("あいう", 1), key({ name: "left" }))).toEqual(st("あいう", 0));
    expect(applyEditKey(st("あいう", 0), key({ name: "left" }))).toEqual(st("あいう", 0));
    expect(applyEditKey(st("あいう", 2), key({ name: "right" }))).toEqual(st("あいう", 3));
    expect(applyEditKey(st("あいう", 3), key({ name: "right" }))).toEqual(st("あいう", 3));
  });

  test("home / end で行頭・行末へ移動する", () => {
    expect(applyEditKey(st("あいう", 2), key({ name: "home" }))).toEqual(st("あいう", 0));
    expect(applyEditKey(st("あいう", 1), key({ name: "end" }))).toEqual(st("あいう", 3));
  });

  test("印字可能文字をカーソル位置に挿入する（変換しない）", () => {
    expect(applyEditKey(st("あう", 1), key({ name: "k", sequence: "い" }))).toEqual(
      st("あいう", 2),
    );
    // ローマ字も素のまま入る（かな変換されない）
    expect(applyEditKey(st("", 0), key({ name: "k", sequence: "k" }))).toEqual(st("k", 1));
  });

  test("space はカーソル位置に空白を挿入する", () => {
    expect(applyEditKey(st("ab", 1), key({ name: "space", sequence: " " }))).toEqual(st("a b", 2));
  });

  test("backspace はカーソル手前の 1 文字を削る（先頭では無効）", () => {
    expect(applyEditKey(st("あいう", 2), key({ name: "backspace" }))).toEqual(st("あう", 1));
    expect(applyEditKey(st("あいう", 0), key({ name: "backspace" }))).toEqual(st("あいう", 0));
  });

  test("delete はカーソル位置の 1 文字を削る（末尾では無効）", () => {
    expect(applyEditKey(st("あいう", 1), key({ name: "delete" }))).toEqual(st("あう", 1));
    expect(applyEditKey(st("あいう", 3), key({ name: "delete" }))).toEqual(st("あいう", 3));
  });

  test("ctrl / meta 併用と未対応キーは状態を変えない", () => {
    expect(applyEditKey(st("a", 1), key({ name: "a", sequence: "a", ctrl: true }))).toEqual(
      st("a", 1),
    );
    expect(applyEditKey(st("a", 1), key({ name: "f1", sequence: "OP" }))).toEqual(st("a", 1));
  });
});

const lens = (main: number, related = 0, detail = 0): ScreenLens => ({ main, related, detail });
const cur = (pane: Cursor["pane"], index: number, mode: Cursor["mode"]): Cursor => ({
  pane,
  index,
  mode,
});

describe("applyCursorKey - select モード", () => {
  test("up は前のチャンクへ移動し、先頭でクランプする", () => {
    expect(applyCursorKey(cur("main", 2, "select"), key({ name: "up" }), lens(3))).toEqual({
      type: "move",
      cursor: cur("main", 1, "select"),
    });
    expect(applyCursorKey(cur("main", 0, "select"), key({ name: "up" }), lens(3))).toEqual({
      type: "move",
      cursor: cur("main", 0, "select"),
    });
  });

  test("main の down は末尾 View の次で New(input) へ落ちる", () => {
    expect(applyCursorKey(cur("main", 0, "select"), key({ name: "down" }), lens(3))).toEqual({
      type: "move",
      cursor: cur("main", 1, "select"),
    });
    // 末尾 View（index===main-1）の下は New
    expect(applyCursorKey(cur("main", 2, "select"), key({ name: "down" }), lens(3))).toEqual({
      type: "move",
      cursor: cur("main", 3, "input"),
    });
  });

  test("related/detail の down は末尾でクランプする（New に落ちない）", () => {
    expect(applyCursorKey(cur("related", 1, "select"), key({ name: "down" }), lens(0, 2))).toEqual({
      type: "move",
      cursor: cur("related", 1, "select"),
    });
    expect(
      applyCursorKey(cur("detail", 0, "select"), key({ name: "down" }), lens(0, 0, 2)),
    ).toEqual({ type: "move", cursor: cur("detail", 1, "select") });
  });

  test("right は隣ペインの index 0 へ移動し、空ペインはスキップする", () => {
    // main → related（detail 空）
    expect(applyCursorKey(cur("main", 1, "select"), key({ name: "right" }), lens(3, 2))).toEqual({
      type: "move",
      cursor: cur("related", 0, "select"),
    });
    // related 空をスキップして detail へ
    expect(applyCursorKey(cur("main", 1, "select"), key({ name: "right" }), lens(3, 0, 2))).toEqual(
      {
        type: "move",
        cursor: cur("detail", 0, "select"),
      },
    );
    // 右に何も無ければ none
    expect(applyCursorKey(cur("main", 1, "select"), key({ name: "right" }), lens(3))).toEqual({
      type: "none",
    });
  });

  test("left で main へ戻ると、main が空のとき New(input) へ着地する", () => {
    expect(applyCursorKey(cur("related", 0, "select"), key({ name: "left" }), lens(2, 1))).toEqual({
      type: "move",
      cursor: cur("main", 0, "select"),
    });
    // main が空（View 0 個）なら index 0 = New(input)
    expect(applyCursorKey(cur("related", 0, "select"), key({ name: "left" }), lens(0, 1))).toEqual({
      type: "move",
      cursor: cur("main", 0, "input"),
    });
  });

  test("select(Enter/Space) は View で menu-view、Digest で expand-digest を返す", () => {
    // View（main/detail）の Enter/Space はメニューダイアログ（二段階起動）
    expect(applyCursorKey(cur("main", 1, "select"), key({ name: "return" }), lens(3))).toEqual({
      type: "menu-view",
      pane: "main",
      index: 1,
    });
    expect(
      applyCursorKey(cur("main", 1, "select"), key({ name: "space", sequence: " " }), lens(3)),
    ).toEqual({ type: "menu-view", pane: "main", index: 1 });
    expect(
      applyCursorKey(cur("detail", 0, "select"), key({ name: "enter" }), lens(0, 0, 2)),
    ).toEqual({ type: "menu-view", pane: "detail", index: 0 });
    // Digest（related）の Enter/Space は詳細展開
    expect(
      applyCursorKey(cur("related", 1, "select"), key({ name: "return" }), lens(0, 3)),
    ).toEqual({ type: "expand-digest", index: 1 });
    expect(
      applyCursorKey(
        cur("related", 1, "select"),
        key({ name: "space", sequence: " " }),
        lens(0, 3),
      ),
    ).toEqual({ type: "expand-digest", index: 1 });
  });

  test("edit(e) は View で edit-view、Digest（related）は none", () => {
    expect(
      applyCursorKey(cur("main", 1, "select"), key({ name: "e", sequence: "e" }), lens(3)),
    ).toEqual({ type: "edit-view", pane: "main", index: 1 });
    expect(
      applyCursorKey(cur("detail", 0, "select"), key({ name: "e", sequence: "e" }), lens(0, 0, 2)),
    ).toEqual({ type: "edit-view", pane: "detail", index: 0 });
    // related の e は無効
    expect(
      applyCursorKey(cur("related", 1, "select"), key({ name: "e", sequence: "e" }), lens(0, 3)),
    ).toEqual({ type: "none" });
    // Ctrl+e は edit ではない
    expect(
      applyCursorKey(
        cur("main", 1, "select"),
        key({ name: "e", sequence: "e", ctrl: true }),
        lens(3),
      ),
    ).toEqual({ type: "none" });
  });

  test("Esc は close、印字・backspace は none", () => {
    expect(applyCursorKey(cur("main", 0, "select"), key({ name: "escape" }), lens(2))).toEqual({
      type: "close",
    });
    expect(
      applyCursorKey(cur("main", 0, "select"), key({ name: "a", sequence: "a" }), lens(2)),
    ).toEqual({ type: "none" });
    expect(applyCursorKey(cur("main", 0, "select"), key({ name: "backspace" }), lens(2))).toEqual({
      type: "none",
    });
  });

  test("delete(d/Del) は main/detail の View で delete-view、related は none", () => {
    expect(
      applyCursorKey(cur("main", 1, "select"), key({ name: "d", sequence: "d" }), lens(3)),
    ).toEqual({ type: "delete-view", pane: "main", index: 1 });
    // Delete キーも delete アクション
    expect(applyCursorKey(cur("main", 1, "select"), key({ name: "delete" }), lens(3))).toEqual({
      type: "delete-view",
      pane: "main",
      index: 1,
    });
    expect(
      applyCursorKey(cur("detail", 0, "select"), key({ name: "d", sequence: "d" }), lens(0, 0, 2)),
    ).toEqual({ type: "delete-view", pane: "detail", index: 0 });
    // Digest（related）の d は削除対象外 → none
    expect(
      applyCursorKey(cur("related", 1, "select"), key({ name: "d", sequence: "d" }), lens(0, 3)),
    ).toEqual({ type: "none" });
  });

  test("Ctrl+d は select では delete-view にならず none", () => {
    expect(
      applyCursorKey(
        cur("main", 1, "select"),
        key({ name: "d", sequence: "d", ctrl: true }),
        lens(3),
      ),
    ).toEqual({ type: "none" });
  });
});

describe("applyDialogKey", () => {
  test("y / Enter は confirm", () => {
    expect(applyDialogKey(key({ name: "y", sequence: "y" }))).toBe("confirm");
    expect(applyDialogKey(key({ name: "return" }))).toBe("confirm");
    expect(applyDialogKey(key({ name: "enter" }))).toBe("confirm");
  });

  test("n / Esc は cancel", () => {
    expect(applyDialogKey(key({ name: "n", sequence: "n" }))).toBe("cancel");
    expect(applyDialogKey(key({ name: "escape" }))).toBe("cancel");
  });

  test("その他のキーは none", () => {
    expect(applyDialogKey(key({ name: "a", sequence: "a" }))).toBe("none");
    expect(applyDialogKey(key({ name: "d", sequence: "d" }))).toBe("none");
    expect(applyDialogKey(key({ name: "space", sequence: " " }))).toBe("none");
  });

  test("Ctrl / Meta 併用は none（ダイアログ中は exit 等も握りつぶす）", () => {
    expect(applyDialogKey(key({ name: "y", sequence: "y", ctrl: true }))).toBe("none");
    expect(applyDialogKey(key({ name: "c", sequence: "c", ctrl: true }))).toBe("none");
    expect(applyDialogKey(key({ name: "n", sequence: "n", meta: true }))).toBe("none");
  });
});

describe("applyCursorKey - input モード", () => {
  test("New で up かつ View があれば直上 View(select) へ", () => {
    expect(applyCursorKey(cur("main", 3, "input"), key({ name: "up" }), lens(3))).toEqual({
      type: "move",
      cursor: cur("main", 2, "select"),
    });
    // View が無ければ none（移動先が無い）
    expect(applyCursorKey(cur("main", 0, "input"), key({ name: "up" }), lens(0))).toEqual({
      type: "none",
    });
  });

  test("New の down・印字や Edit のキーは none（App 側が処理）", () => {
    expect(applyCursorKey(cur("main", 3, "input"), key({ name: "down" }), lens(3))).toEqual({
      type: "none",
    });
    expect(
      applyCursorKey(cur("main", 3, "input"), key({ name: "a", sequence: "a" }), lens(3)),
    ).toEqual({ type: "none" });
    // Edit（New 以外の input）は左右含めすべて none
    expect(applyCursorKey(cur("main", 1, "input"), key({ name: "left" }), lens(3))).toEqual({
      type: "none",
    });
    expect(applyCursorKey(cur("detail", 0, "input"), key({ name: "up" }), lens(0, 0, 2))).toEqual({
      type: "none",
    });
  });
});

describe("clampCursor", () => {
  test("New（index>=main の input）は lens.main へ追従する", () => {
    // 末尾以降を指す input は常に New 扱い（末尾に貼り付く）
    expect(clampCursor(cur("main", 3, "input"), lens(3))).toEqual(cur("main", 3, "input"));
    expect(clampCursor(cur("main", 5, "input"), lens(3))).toEqual(cur("main", 3, "input"));
    expect(clampCursor(cur("main", 0, "input"), lens(0))).toEqual(cur("main", 0, "input"));
  });

  test("select View は有効最大へクランプする", () => {
    expect(clampCursor(cur("main", 5, "select"), lens(3))).toEqual(cur("main", 2, "select"));
    expect(clampCursor(cur("related", 1, "select"), lens(0, 5))).toEqual(
      cur("related", 1, "select"),
    );
  });

  test("ペインが空になったら main の New へフォールバックする", () => {
    // related が空になった
    expect(clampCursor(cur("related", 0, "select"), lens(2))).toEqual(cur("main", 2, "input"));
    // main の View を指していたが View が全部消えた → New
    expect(clampCursor(cur("main", 1, "select"), lens(0))).toEqual(cur("main", 0, "input"));
  });
});

describe("applyMenuKey", () => {
  test("up / down で項目を移動し、両端でクランプする", () => {
    expect(applyMenuKey(1, key({ name: "up" }), 3)).toEqual({ type: "move", index: 0 });
    expect(applyMenuKey(0, key({ name: "up" }), 3)).toEqual({ type: "move", index: 0 });
    expect(applyMenuKey(0, key({ name: "down" }), 3)).toEqual({ type: "move", index: 1 });
    expect(applyMenuKey(2, key({ name: "down" }), 3)).toEqual({ type: "move", index: 2 });
  });

  test("select(Enter/Space) は choose", () => {
    expect(applyMenuKey(0, key({ name: "return" }), 2)).toEqual({ type: "choose" });
    expect(applyMenuKey(0, key({ name: "enter" }), 2)).toEqual({ type: "choose" });
    expect(applyMenuKey(0, key({ name: "space", sequence: " " }), 2)).toEqual({ type: "choose" });
  });

  test("cancel(Esc) は cancel、その他は none", () => {
    expect(applyMenuKey(0, key({ name: "escape" }), 2)).toEqual({ type: "cancel" });
    expect(applyMenuKey(0, key({ name: "a", sequence: "a" }), 2)).toEqual({ type: "none" });
    expect(applyMenuKey(0, key({ name: "d", sequence: "d" }), 2)).toEqual({ type: "none" });
  });
});
