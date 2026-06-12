import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { existsSync } from "node:fs";
import { AncoEngine, defaultAncoPath } from "@/conversion/anco/engine.ts";
import { identityEngine } from "@/conversion/engine.ts";
import { createDb } from "@/db/client.ts";
import { localDate } from "@/entry/autosave.ts";
import { getOrCreateEntry } from "@/entry/repository.ts";
import { defaultVaultDir } from "@/export/obsidian.ts";
import { App } from "@/tui/App.tsx";

// ゼロフリクション起動（docs/FEATURES.md 候補2）:
// 設定・引数なしで起動し、当日エントリの末尾から即入力できる。
if (!process.stdout.isTTY) {
  console.error("zakki: 対話端末（TTY）で実行してください");
  process.exit(1);
}

const db = createDb();
const date = localDate();
const entry = getOrCreateEntry(db, date).match(
  (e) => e,
  (e): never => {
    console.error(`zakki: DB エラー: ${e.message}`);
    process.exit(1);
  },
);

// anco 未導入（scripts/install-anco.sh 未実行）の環境では、かなのまま
// 動作する identity エンジンにフォールバックする（docs/FEATURES.md §変換エンジン）
const ancoPath = defaultAncoPath();
const engine = existsSync(ancoPath) ? new AncoEngine(ancoPath) : identityEngine;

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App db={db} date={date} initialRaw={entry.raw} vaultDir={defaultVaultDir()} engine={engine} />,
);
