import type { Result } from "neverthrow";
import { chunkText, makeTitle } from "@/chunk/chunker.ts";
import type { TopicGrouper } from "@/chunk/grouper.ts";
import type { Db } from "@/db/client.ts";
import type { DbError } from "@/db/error.ts";
import type { SavedEntry } from "./repository.ts";
import { saveSnapshot } from "./repository.ts";

/** ローカルタイムゾーンの YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 自動保存の入口。converted から一次チャンク（文単位）を再生成し、
 * grouper があれば話題転換検出（二次区切り）で隣接文をまとめてから永続化する。
 * 末尾の書きかけ文はグルーピング対象にしない（完成し次第追いつく）。
 * デバウンスは呼び出し側（UI 層）の責務。
 */
export function persistEntry(
  db: Db,
  input: { date: string; raw: string; converted: string },
  grouper?: TopicGrouper,
): Result<SavedEntry, DbError> {
  const drafts = chunkText(input.converted);
  let chunkDrafts = drafts;
  if (grouper !== undefined && drafts.length > 2) {
    const completed = drafts.slice(0, -1).map((d) => d.content);
    const tail = drafts.at(-1);
    chunkDrafts = grouper.group(completed).map((group) => {
      const content = group.join("");
      return { title: makeTitle(content), content };
    });
    if (tail !== undefined) {
      chunkDrafts.push(tail);
    }
  }
  return saveSnapshot(db, { ...input, chunks: chunkDrafts });
}
