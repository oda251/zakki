import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ResultAsync } from "neverthrow";

export interface ExportError {
  readonly type: "export-error";
  readonly message: string;
  readonly cause: unknown;
}

export interface ExportChunk {
  position: number;
  content: string;
  /** 自動付与タグ（frontmatter に出力） */
  tags?: string[];
  /** 関連チャンクのノート名（[[リンク]] として出力） */
  related?: string[];
  /** ネガポジ極性スコア [-1,+1]（frontmatter mood に出力） */
  polarity?: number;
}

export interface ExportSummary {
  written: number;
  skipped: number;
  deleted: number;
}

export interface ExportEntryInput {
  /** 書き出し先ディレクトリ（vault 内のサブフォルダ） */
  vaultDir: string;
  /** エントリのローカル日付 YYYY-MM-DD */
  date: string;
  chunks: ExportChunk[];
}

/** zakki が管理するファイルであることを示す frontmatter マーカー */
const SOURCE_MARKER = "source: zakki";

const toExportError = (cause: unknown): ExportError => ({
  type: "export-error",
  message: cause instanceof Error ? cause.message : String(cause),
  cause,
});

export function defaultVaultDir(): string {
  // ZAKKI_VAULT_DIR で出力先を差し替え可能（お試し用のサンドボックス・別 vault 等）
  const override = process.env["ZAKKI_VAULT_DIR"];
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), "obsidian-vault", "zakki");
}

/**
 * チャンクを Markdown として vault へ一方向エクスポートする（docs/FEATURES.md
 * §Obsidian エクスポート）。SQLite が source of truth。冪等であり、内容が
 * 一致するファイルは書き換えない（Obsidian 側の同期ノイズを避ける）。
 * 同一日付の zakki 管理ファイルのうち現存チャンクに対応しないものは削除する。
 */
export function exportEntry(input: ExportEntryInput): ResultAsync<ExportSummary, ExportError> {
  return ResultAsync.fromPromise(doExport(input), toExportError);
}

async function doExport({ vaultDir, date, chunks }: ExportEntryInput): Promise<ExportSummary> {
  await mkdir(vaultDir, { recursive: true });
  const summary: ExportSummary = { written: 0, skipped: 0, deleted: 0 };
  const expected = new Set<string>();

  for (const chunk of chunks) {
    const name = fileName(date, chunk.position);
    expected.add(name);
    const path = join(vaultDir, name);
    const body = renderChunk(date, chunk);
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === body) {
      summary.skipped++;
      continue;
    }
    await writeFile(path, body, "utf8");
    summary.written++;
  }

  const managed = new RegExp(`^${date}-\\d{3}\\.md$`);
  for (const name of await readdir(vaultDir)) {
    if (!managed.test(name) || expected.has(name)) {
      continue;
    }
    const path = join(vaultDir, name);
    // zakki 製マーカーを持つファイルのみ削除する（ユーザー自作ファイルの保護）
    const current = await readFile(path, "utf8").catch(() => null);
    if (current !== null && current.includes(SOURCE_MARKER)) {
      await unlink(path);
      summary.deleted++;
    }
  }

  return summary;
}

/** Obsidian 上のノート名（拡張子なし）。[[リンク]] のターゲットにも使う */
export function noteName(date: string, position: number): string {
  return `${date}-${String(position).padStart(3, "0")}`;
}

function fileName(date: string, position: number): string {
  return `${noteName(date, position)}.md`;
}

function renderChunk(date: string, chunk: ExportChunk): string {
  const lines = ["---", `date: ${date}`, `position: ${chunk.position}`];
  if (chunk.polarity !== undefined) {
    lines.push(`mood: ${chunk.polarity.toFixed(2)}`);
  }
  const tags = chunk.tags ?? [];
  if (tags.length > 0) {
    lines.push("tags:", ...tags.map((t) => `  - ${t}`));
  }
  lines.push(SOURCE_MARKER, "---", "", chunk.content, "");
  const related = chunk.related ?? [];
  if (related.length > 0) {
    lines.push("", "## 関連", "", ...related.map((name) => `- [[${name}]]`), "");
  }
  return lines.join("\n");
}
