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

/** 行の先頭トークン（スクロールバー █ や余白を除いた最初の語） */
function firstToken(row: string): string {
  return row.replace(/[█\s]+$/u, "").trim();
}

const CHUNKS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"];

async function pressUp(t: Awaited<ReturnType<typeof setup>>, n: number) {
  for (let i = 0; i < n; i++) {
    t.mockInput.pressArrow("up");
    await t.flush();
  }
  // フレーム更新（毎フレームの stickyScroll 再適用など）を回し切る。
  // 末尾吸着が anchor を押し戻すデグレはここで初めて顕在化する。
  await t.waitForVisualIdle();
}

describe("チャンクリストの表示窓（docs/PANES.md §5）", () => {
  test("初期（New）は末尾に吸着し、最新チャンク＋カーソルを表示する", async () => {
    const t = await setup(CHUNKS);
    await t.flush();
    const r = rows(t.captureCharFrame());
    expect(r).toContain("L8");
    expect(r.join("\n")).toContain("▌"); // 入力カーソル
    expect(r.join("\n")).not.toContain("L1"); // 古い側はスクロールアウト
    t.renderer.destroy();
  });

  test("View へ ↑ で移動すると、カーソルの 1 件手前が上端に来る", async () => {
    const t = await setup(CHUNKS);
    await t.flush();
    // New(8) → L8(7) → L7(6) → L6(5) → L5(4)。カーソル=L5、1 件手前=L4
    await pressUp(t, 4);
    const r = rows(t.captureCharFrame());
    expect(firstToken(r[0] ?? "")).toBe("L4"); // 1 件手前が上端
    expect(r).toContain("L5"); // カーソルチャンク
    // カーソルより新しい側（L6…）が入る限り下へ並ぶ
    expect(r).toContain("L6");
    t.renderer.destroy();
  });

  test("先頭まで ↑ で上がると L1 が上端に出る", async () => {
    const t = await setup(CHUNKS);
    await t.flush();
    await pressUp(t, 8);
    const r = rows(t.captureCharFrame());
    expect(firstToken(r[0] ?? "")).toBe("L1");
    expect(r).toContain("L2");
    t.renderer.destroy();
  });
});
