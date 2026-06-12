import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
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

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App db={db} date={date} initialRaw={entry.raw} vaultDir={defaultVaultDir()} />,
);
