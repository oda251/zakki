import type { ResultAsync } from "neverthrow";
import { chunkText } from "@zakki/core/chunk/chunker.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import type { Chunk } from "@zakki/data/db/schema.ts";
import { saveChildren } from "@zakki/data/chunk/repository.ts";

/**
 * 親バッファ自動保存の入口。converted（変換後テキスト・凍結リテラルマーカー付き可）を
 * Enter 区切りの決定的チャンク化（chunkText）で子チャンクへ投影し永続化する
 * （docs/CHUNKS.md）。デバウンスは呼び出し側（UI 層）の責務。
 *
 * 親チャンクが存在しなければ Err ではなく null を返す
 * （呼び出し側が 404 等に写せるように）。存在確認は saveChildren が保存と同一
 * トランザクション内で行う（issue #58 項目 5: 事前読みだと読み〜書きの間の
 * 親削除がすり抜ける）。
 */
export function persistChildren(
  db: Db,
  parentId: number,
  converted: string,
): ResultAsync<Chunk[] | null, DbError> {
  return saveChildren(db, parentId, chunkText(converted));
}
