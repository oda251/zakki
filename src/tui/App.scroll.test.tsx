import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { identityEngine } from "@/conversion/engine.ts";
import { wrapPaste } from "@/conversion/paste.ts";
import { createDb } from "@/db/client.ts";
import { App } from "./App.tsx";

/**
 * チャンクリストの表示窓（docs/PANES.md §5）を実レンダリングで検証する。
 * createTestRenderer 経由で App を描画し、矢印キーでカーソルを動かして
 * captureCharFrame の文字列に出る/出ないを assert する。
 */
async function setup(rawChunks: string[], width = 20, height = 6) {
  const db = createDb(":memory:");
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
    />,
    { width, height },
  );
  // testRender は IS_REACT_ACT_ENVIRONMENT を true にしたまま返す。以降は手動 flush で
  // 描画を駆動するため act 強制を切り、非同期 setState の act 警告ノイズを抑止する。
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  return t;
}

/** フレーム文字列を行配列へ（末尾空白は落とす） */
function rows(frame: string): string[] {
  return frame.split("\n").map((r) => r.trimEnd());
}

/** 行の先頭トークン（余白・スクロールバー文字を挟んだ最初の語） */
function firstToken(row: string): string {
  return row.trim().split(/\s+/u)[0] ?? "";
}

/** いずれかの行の先頭がそのチャンク名か（スクロールバー列を無視して可視判定する） */
function visible(r: string[], label: string): boolean {
  return r.some((row) => firstToken(row) === label);
}

const CHUNKS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];

/** 1 キー押下後、React のスケジューラが state 更新をコミットするまで待つ。
 * 連続 flush だけでは次の再描画が間に合わないため、毎押下ごとに settle させる。 */
async function pressUp(t: Awaited<ReturnType<typeof setup>>, n: number) {
  for (let i = 0; i < n; i++) {
    t.mockInput.pressArrow("up");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await t.flush();
  }
}

describe("チャンクリストの表示窓（docs/PANES.md §5）", () => {
  // renderer 生成が重いので 1 つの renderer で段階的に検証する
  test("1件手前を上端に、新しい側は入る限り、古い側は描画しない", async () => {
    const t = await setup(CHUNKS, 16, 6);
    await t.flush();

    // 初期（New）: 最後の確定チャンク（L8）＋入力行だけ。古い側は出ない
    let r = rows(t.captureCharFrame());
    expect(firstToken(r[0] ?? "")).toBe("L8");
    expect(r.join("\n")).toContain("▌"); // 入力カーソル
    expect(visible(r, "L7")).toBe(false);

    // ↑×4 → カーソル=L5。1 件手前 L4 が上端、新しい側 L5,L6… が並び、L3 は出ない
    await pressUp(t, 4);
    r = rows(t.captureCharFrame());
    expect(firstToken(r[0] ?? "")).toBe("L4");
    expect(visible(r, "L5")).toBe(true);
    expect(visible(r, "L6")).toBe(true);
    expect(visible(r, "L3")).toBe(false);

    // さらに ↑×4 → 先頭 L1 が上端（古い側が無い）
    await pressUp(t, 4);
    r = rows(t.captureCharFrame());
    expect(firstToken(r[0] ?? "")).toBe("L1");
    expect(visible(r, "L2")).toBe(true);

    t.renderer.destroy();
  }, 20000);
});
