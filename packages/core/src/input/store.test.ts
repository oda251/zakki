import { describe, expect, test } from "bun:test";
import type { Cursor, KeyLike } from "./controller.ts";
import { createEditorStore, type Editing } from "./store.ts";

const cursor = (): Cursor => ({ pane: "main", index: 0, mode: "input" });
const key = (partial: Partial<KeyLike> & { name: string }): KeyLike => ({
  sequence: "",
  ctrl: false,
  meta: false,
  ...partial,
});
const editing = (text: string, cur: number): Editing => ({
  target: { kind: "main", start: 0, end: 0 },
  text,
  cursor: cur,
  old: text,
});

describe("createEditorStore", () => {
  test("初期状態を保持する", () => {
    const store = createEditorStore({ raw: "abc", cursor: cursor() });
    const s = store.getState();
    expect(s.raw).toBe("abc");
    expect(s.conversionVersion).toBe(0);
    expect(s.editing).toBeNull();
    expect(s.cursor).toEqual(cursor());
  });

  test("setRaw は getState() で同期に読める（ref 二重持ちの代替）", () => {
    const store = createEditorStore({ raw: "", cursor: cursor() });
    store.getState().setRaw("あ");
    expect(store.getState().raw).toBe("あ");
    // 連続更新も最新が即読める
    store.getState().setRaw(`${store.getState().raw}い`);
    expect(store.getState().raw).toBe("あい");
  });

  test("bumpConversion は conversionVersion を増やす", () => {
    const store = createEditorStore({ raw: "", cursor: cursor() });
    store.getState().bumpConversion();
    store.getState().bumpConversion();
    expect(store.getState().conversionVersion).toBe(2);
  });

  test("setCursor / setEditing を反映する", () => {
    const store = createEditorStore({ raw: "", cursor: cursor() });
    const next: Cursor = { pane: "detail", index: 2, mode: "select" };
    store.getState().setCursor(next);
    expect(store.getState().cursor).toEqual(next);
    const e = editing("x", 1);
    store.getState().setEditing(e);
    expect(store.getState().editing).toEqual(e);
    store.getState().setEditing(null);
    expect(store.getState().editing).toBeNull();
  });

  test("applyEditKey は editing が null なら no-op", () => {
    const store = createEditorStore({ raw: "", cursor: cursor() });
    store.getState().applyEditKey(key({ name: "a", sequence: "a" }));
    expect(store.getState().editing).toBeNull();
  });

  test("applyEditKey は editing に文字挿入・カーソル移動を適用する", () => {
    const store = createEditorStore({ raw: "", cursor: cursor() });
    store.getState().setEditing(editing("", 0));
    store.getState().applyEditKey(key({ name: "a", sequence: "a" }));
    expect(store.getState().editing).toMatchObject({ text: "a", cursor: 1 });
    store.getState().applyEditKey(key({ name: "left" }));
    expect(store.getState().editing).toMatchObject({ text: "a", cursor: 0 });
    // target/old は保持される
    expect(store.getState().editing?.target).toEqual({ kind: "main", start: 0, end: 0 });
  });

  test("subscribe で変更通知が届く", () => {
    const store = createEditorStore({ raw: "", cursor: cursor() });
    let calls = 0;
    const unsub = store.subscribe(() => {
      calls += 1;
    });
    store.getState().setRaw("a");
    store.getState().setCursor({ pane: "main", index: 1, mode: "select" });
    unsub();
    store.getState().setRaw("b");
    expect(calls).toBe(2);
  });
});
