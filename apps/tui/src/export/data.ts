import { Result } from "neverthrow";
import { scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import {
  listChunksWithDate,
  listLinksByChunk,
  listTagsByChunk,
} from "@zakki/data/entry/queries.ts";
import type { ExportChunk } from "./obsidian.ts";
import { noteName } from "./obsidian.ts";

/**
 * 指定日のエントリのエクスポート素材（タグ・関連 [[リンク]] 込み）を組み立てる
 * （docs/FEATURES.md §Obsidian エクスポート）。
 */
export function getEntryExportChunks(db: Db, date: string): Result<ExportChunk[], DbError> {
  return Result.combine([listChunksWithDate(db), listTagsByChunk(db), listLinksByChunk(db)]).map(
    ([allChunks, tagsByChunk, linksByChunk]) => {
      const nameById = new Map(allChunks.map((c) => [c.id, noteName(c.date, c.position)]));
      return allChunks
        .filter((c) => c.date === date)
        .map((c) => ({
          position: c.position,
          content: c.content,
          // 永続化済み polarity を使い、未解析（null）のみその場算出にフォールバック
          polarity: c.polarity ?? scoreSentiment(c.content),
          tags: tagsByChunk.get(c.id) ?? [],
          related: (linksByChunk.get(c.id) ?? [])
            .map((id) => nameById.get(id))
            .filter((name): name is string => name !== undefined),
        }));
    },
  );
}
