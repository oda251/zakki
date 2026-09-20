import { blobChunkLabel } from "@zakki/core/file/name.ts";
import type { Chunk, ZakkiFile } from "@zakki/data/db/schema.ts";

/**
 * blob チャンク（issue #157）の TUI 表示。
 *
 * blob チャンクは編集可能なテキストではないため `buildRaw`（バッファの復元元）には
 * 混ぜない。混ぜると打ち直しのたびに raw から再チャンク化されて二重のチャンクに
 * なる（docs/tmp/157-file-upload.md G3）。text/blob を分けたあと、blob 側は
 * 表示専用の行（ファイル名だけ）に変換して読み取り専用で並べる。
 */

/** kind ごとにチャンクを分ける。入力順を保つ（表示順の基準になる）。 */
export function splitChunksByKind(children: readonly Chunk[]): { text: Chunk[]; blob: Chunk[] } {
  const text: Chunk[] = [];
  const blob: Chunk[] = [];
  for (const c of children) {
    (c.kind === "blob" ? blob : text).push(c);
  }
  return { text, blob };
}

/**
 * blob チャンクの表示行（ファイル名のみ）。TUI は FEK を持たないため、
 * `encryption === "password"` の行は復号できず name: null（プレースホルダ）になる。
 * 対応する files 行が引けない blob チャンク（同期途中の孤児）は飛ばす。
 */
export function blobChunkLines(
  blobChunks: readonly Chunk[],
  filesByChunk: ReadonlyMap<number, ZakkiFile>,
): { id: number; text: string }[] {
  const lines: { id: number; text: string }[] = [];
  for (const c of blobChunks) {
    const file = filesByChunk.get(c.id);
    if (file === undefined) {
      continue;
    }
    lines.push({
      id: c.id,
      text: blobChunkLabel({
        name: file.encryption === "password" ? null : file.name,
        extension: file.extension,
      }),
    });
  }
  return lines;
}
