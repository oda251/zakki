import { ResultAsync } from "neverthrow";
import { scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import {
  listChunksWithDate,
  listLinksByChunk,
  listTagsByChunk,
} from "@zakki/data/chunk/queries.ts";
import type { ExportChunk } from "./obsidian.ts";
import { noteName } from "./obsidian.ts";

/**
 * 指定日のエントリのエクスポート素材（タグ・関連 [[リンク]] 込み）を組み立てる
 * （docs/FEATURES.md §Obsidian エクスポート）。
 */
export function getEntryExportChunks(db: Db, date: string): ResultAsync<ExportChunk[], DbError> {
  return ResultAsync.combine([
    listChunksWithDate(db),
    listTagsByChunk(db),
    listLinksByChunk(db),
  ]).map(([allChunks, tagsByChunk, linksByChunk]) => {
    // ノート名の position は「同一日の一覧順の連番」。深い階層のチャンクは親ごとに
    // position が重複し得るため、chunks.position ではなく日付ごとの通し番号を使う
    // （allChunks は日付→親→position 順。同一日の並び順がそのまま連番になる）。
    const seqByDate = new Map<string, number>();
    const nameById = new Map<number, string>();
    for (const c of allChunks) {
      const seq = seqByDate.get(c.date) ?? 0;
      nameById.set(c.id, noteName(c.date, seq));
      seqByDate.set(c.date, seq + 1);
    }
    return allChunks
      .filter((c) => c.date === date)
      .map((c, i) => ({
        position: i,
        content: c.content,
        // 永続化済み polarity を使い、未解析（null）のみその場算出にフォールバック
        polarity: c.polarity ?? scoreSentiment(c.content),
        tags: tagsByChunk.get(c.id) ?? [],
        related: (linksByChunk.get(c.id) ?? [])
          .map((id) => nameById.get(id))
          .filter((name): name is string => name !== undefined),
      }));
  });
}
