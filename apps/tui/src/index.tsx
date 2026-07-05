import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolveDefaultEngine } from "@zakki/backend/anco/engine.ts";
import { loadConversionCache } from "@zakki/data/conversion/cache.ts";
import { loadCorrections } from "@zakki/data/conversion/corrections.ts";
import { resolveDefaultEmbedder } from "@zakki/backend/embedding/embedder.ts";
import { openDb } from "@zakki/data/db/connect.ts";
import { unlockOrSetup } from "@zakki/data/crypto/unlock.ts";
import { loadOrCreateKeyfile } from "@zakki/data/crypto/keyfile.ts";
import { stdinPrompts } from "@zakki/tui/tui/prompt.ts";
import { resolveLocalIdentity } from "@zakki/data/identity/local.ts";
import { localDate } from "@zakki/data/chunk/autosave.ts";
import { getOrCreateDateChunk, listChildren } from "@zakki/data/chunk/repository.ts";
import { buildRaw } from "@zakki/core/entry/records.ts";
import { defaultVaultDir } from "@zakki/tui/export/obsidian.ts";
import { App } from "@zakki/tui/tui/App.tsx";

// ゼロフリクション起動（docs/FEATURES.md 候補2）:
// 設定・引数なしで起動し、当日エントリの末尾から即入力できる。
if (!process.stdout.isTTY) {
  console.error("zakki: 対話端末（TTY）で実行してください");
  process.exit(1);
}

// Identity を解決し、embedded replica（クラウド設定時）/ ローカル専用で DB を開く。
// 開く処理はオフライン安全（ネットワーク I/O なし）。
const identity = resolveLocalIdentity();
const { db, sync } = await openDb(identity);
// E2E 暗号はオプトイン（ZAKKI_ENCRYPTION=1）。有効時は keyfile の KEK でまず無言
// アンロックを試み、初回は DEK を生成してキーファイル／パスフレーズ／リカバリ封筒を
// 作る（リカバリコードを一度だけ表示）。キーファイルが使えない場合はパスフレーズを
// 尋ね、誤りは数回まで再試行する。データアクセス前に DEK を用意する。
if (process.env["ZAKKI_ENCRYPTION"] === "1") {
  const keyfileKek = await loadOrCreateKeyfile();
  const MAX_TRIES = 3;
  let unlocked = false;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      await unlockOrSetup(db, keyfileKek, stdinPrompts);
      unlocked = true;
      break;
    } catch (err) {
      // パスフレーズ違い等。秘密はログに出さず、メッセージのみ提示して再試行する。
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_TRIES) {
        console.error(`zakki: アンロックに失敗しました（${msg}）。再試行してください。`);
      } else {
        console.error(`zakki: アンロックに失敗しました（${msg}）。終了します。`);
      }
    }
  }
  if (!unlocked) {
    process.exit(1);
  }
}
// 起動時の同期はベストエフォート。オフラインや未設定は正常系なので、失敗しても
// 起動は続行する（ローカルレプリカでそのまま動く）。
await sync();
const date = localDate();
// 当日の日付チャンク（トップレベル）を用意し、その直下の子チャンクからバッファ（raw）を
// 再構成する（docs/CHUNKS.md）。raw / converted 列は廃止したため、子チャンクの content が
// バッファの唯一の復元元。打ちかけ行（未確定ローマ字）は前回終了時に失われている（受容済み）。
const dateChunk = await getOrCreateDateChunk(db, date).match(
  (c) => c,
  (e): never => {
    console.error(`zakki: DB エラー: ${e.message}`);
    process.exit(1);
  },
);
const children = await listChildren(db, dateChunk.id).match(
  (cs) => cs,
  (e): never => {
    console.error(`zakki: DB エラー: ${e.message}`);
    process.exit(1);
  },
);
const initialRaw = buildRaw(children.map((c) => c.content));

// anco 未導入（scripts/install-anco.sh 未実行）の環境では、かなのまま
// 動作する identity エンジンにフォールバックする（docs/FEATURES.md §変換エンジン）。
// zenz GGUF（scripts/install-zenz.sh）があれば文脈校正を有効化する
const engine = resolveDefaultEngine();

const corrections = await loadCorrections(db).unwrapOr(new Map());
// 永続化済みの自動変換キャッシュをシードし、毎起動の全文再変換を避ける
const conversionCache = await loadConversionCache(db).unwrapOr(new Map());

// embedding は遅延ロード（初回 embed 時にモデル取得）のため起動をブロックしない。
// ZAKKI_NO_EMBEDDING=1 で無効化できる（完全決定的動作）
const embedder = resolveDefaultEmbedder();

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
  <App
    db={db}
    date={date}
    dateChunkId={dateChunk.id}
    initialRaw={initialRaw}
    vaultDir={defaultVaultDir()}
    engine={engine}
    corrections={corrections}
    conversionCache={conversionCache}
    embedder={embedder}
    sync={sync}
  />,
);
