import type { Result } from "neverthrow";
import { chunkText } from "@/chunk/chunker.ts";
import type { Db } from "@/db/client.ts";
import type { RepoError, SavedEntry } from "./repository.ts";
import { saveSnapshot } from "./repository.ts";

/** ローカルタイムゾーンの YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 自動保存の入口。converted から決定的チャンクを再生成し、
 * エントリ本文とともに永続化する。デバウンスは呼び出し側（UI 層）の責務。
 */
export function persistEntry(
  db: Db,
  input: { date: string; raw: string; converted: string },
): Result<SavedEntry, RepoError> {
  return saveSnapshot(db, { ...input, chunks: chunkText(input.converted) });
}
