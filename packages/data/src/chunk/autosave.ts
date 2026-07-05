import type { ResultAsync } from "neverthrow";
import { okAsync } from "neverthrow";
import { chunkText } from "@zakki/core/chunk/chunker.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import type { Chunk } from "@zakki/data/db/schema.ts";
import { getChunk, saveChildren } from "@zakki/data/chunk/repository.ts";

/** ローカルタイムゾーンの YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 親バッファ自動保存の入口。converted（変換後テキスト・凍結リテラルマーカー付き可）を
 * Enter 区切りの決定的チャンク化（chunkText）で子チャンクへ投影し永続化する
 * （docs/CHUNKS.md）。デバウンスは呼び出し側（UI 層）の責務。
 *
 * 親チャンクが存在しなければ Err ではなく null を返す
 * （呼び出し側が 404 等に写せるように）。
 */
export function persistChildren(
  db: Db,
  parentId: number,
  converted: string,
): ResultAsync<Chunk[] | null, DbError> {
  return getChunk(db, parentId).andThen((parent) =>
    parent === null ? okAsync(null) : saveChildren(db, parentId, chunkText(converted)),
  );
}
