import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { existsSync } from "node:fs";
import { AncoEngine, defaultAncoPath, defaultZenzPath } from "@zakki/tui/conversion/anco/engine.ts";
import { loadConversionCache } from "@zakki/tui/conversion/cache.ts";
import { loadCorrections } from "@zakki/tui/conversion/corrections.ts";
import { identityEngine } from "@zakki/tui/conversion/engine.ts";
import { createRuriEmbedder } from "@zakki/tui/embedding/embedder.ts";
import { createDb } from "@zakki/data/db/client.ts";
import { localDate } from "@zakki/tui/entry/autosave.ts";
import { getOrCreateEntry } from "@zakki/data/entry/repository.ts";
import { defaultVaultDir } from "@zakki/tui/export/obsidian.ts";
import { App } from "@zakki/tui/tui/App.tsx";

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
// 動作する identity エンジンにフォールバックする（docs/FEATURES.md §変換エンジン）。
// zenz GGUF（scripts/install-zenz.sh）があれば文脈校正を有効化する
const ancoPath = defaultAncoPath();
const zenzPath = defaultZenzPath();
const engine = existsSync(ancoPath)
  ? new AncoEngine(ancoPath, existsSync(zenzPath) ? zenzPath : undefined)
  : identityEngine;

const corrections = loadCorrections(db).unwrapOr(new Map());
// 永続化済みの自動変換キャッシュをシードし、毎起動の全文再変換を避ける
const conversionCache = loadConversionCache(db).unwrapOr(new Map());

// embedding は遅延ロード（初回 embed 時にモデル取得）のため起動をブロックしない。
// ZAKKI_NO_EMBEDDING=1 で無効化できる（完全決定的動作）
const embedder = process.env["ZAKKI_NO_EMBEDDING"] === "1" ? null : createRuriEmbedder();

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App
    db={db}
    date={date}
    initialRaw={entry.raw}
    vaultDir={defaultVaultDir()}
    engine={engine}
    corrections={corrections}
    conversionCache={conversionCache}
    embedder={embedder}
  />,
);
