import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { testRender } from "@opentui/react/test-utils";
import { identityEngine } from "@zakki/core/conversion/engine.ts";
import { wrapPaste } from "@zakki/core/conversion/paste.ts";
import { createDb } from "@zakki/data/db/client.ts";
import { App } from "./App.tsx";

/**
 * 入力フロー（インライン編集・ペースト・削除）を実 App レンダリングで検証する。
 * Phase B（zustand 化）で配線が変わった経路の統合カバレッジ。controller.test が
 * キー操作ロジックを、本ファイルが「実 App でその経路が通る」ことを担保する。
 */
async function setup(rawChunks: string[], width = 24, height = 8) {
  const db = await createDb(":memory:");
  const initialRaw = rawChunks.map((c) => wrapPaste(c)).join("");
  const t = await testRender(
    <App
      db={db}
      date="2026-06-14"
      initialRaw={initialRaw}
      vaultDir="/tmp/zakki-test-vault"
      engine={identityEngine}
      corrections={new Map()}
      conversionCache={new Map()}
      embedder={null}
      sync={() => Promise.resolve(ok(undefined))}
    />,
    { width, height },
  );
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  return t;
}

const FRAME = (t: Awaited<ReturnType<typeof setup>>) => t.captureCharFrame();

/** キー押下のたびに React のコミットを待つ（既存 App.scroll.test と同じ間合い） */
async function settle(t: Awaited<ReturnType<typeof setup>>, ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await t.flush();
}

describe("入力フロー（編集・ペースト・削除）の統合", () => {
  test("View を編集して文字を足し Enter で確定するとチャンク内容が更新される", async () => {
    const t = await setup(["hello"]);
    await t.flush();

    t.mockInput.pressArrow("up"); // New → 直上 View(select)
    await settle(t);
    t.mockInput.pressKey("e"); // edit を開く
    await settle(t);
    await t.mockInput.typeText("X"); // 末尾に挿入
    await settle(t);
    t.mockInput.pressEnter(); // 確定
    await settle(t, 100);

    expect(FRAME(t)).toContain("helloX");
    t.renderer.destroy();
  }, 20000);

  test("編集を Esc で取り消すと元のテキストに戻る", async () => {
    const t = await setup(["hello"]);
    await t.flush();

    t.mockInput.pressArrow("up");
    await settle(t);
    t.mockInput.pressKey("e");
    await settle(t);
    await t.mockInput.typeText("ZZZ");
    await settle(t);
    t.mockInput.pressEscape(); // 取消
    await settle(t, 100);

    const frame = FRAME(t);
    expect(frame).toContain("hello");
    expect(frame).not.toContain("helloZZZ");
    expect(frame).not.toContain("ZZZ");
    t.renderer.destroy();
  }, 20000);

  test("ペーストは 1 チャンク（verbatim）として追加される", async () => {
    const t = await setup([]);
    await t.flush();

    await t.mockInput.pasteBracketedText("メモ書き");
    await settle(t, 100);

    expect(FRAME(t)).toContain("メモ書き");
    t.renderer.destroy();
  }, 20000);

  test("View を削除（d → 確認ダイアログ y）するとチャンクが消える", async () => {
    const t = await setup(["けすよ"]);
    await t.flush();
    expect(FRAME(t)).toContain("けすよ");

    t.mockInput.pressArrow("up"); // 対象 View を select
    await settle(t);
    t.mockInput.pressKey("d"); // 削除 → 確認ダイアログ
    await settle(t);
    t.mockInput.pressKey("y"); // 確定
    await settle(t, 100);

    expect(FRAME(t)).not.toContain("けすよ");
    t.renderer.destroy();
  }, 20000);
});
