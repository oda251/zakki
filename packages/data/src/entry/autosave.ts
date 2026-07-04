import type { ResultAsync } from "neverthrow";
import { okAsync } from "neverthrow";
import { chunkText } from "@zakki/core/chunk/chunker.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import type { SavedEntry } from "@zakki/data/entry/repository.ts";
import { saveSnapshot } from "@zakki/data/entry/repository.ts";
import { getSession } from "@zakki/data/session/repository.ts";

/** ローカルタイムゾーンの YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  const y = String(d.getFullYear()).padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 自動保存の入口。converted を句点・改行の決定的区切りでチャンク化して永続化する
 * （記録モデル, docs/RECORDS.md）。話題グルーピング（二次区切り）は廃止。
 * デバウンスは呼び出し側（UI 層）の責務。
 *
 * `sessionId` は起動時に解決済みならそれを渡す（保存のたびのデフォルト
 * セッション解決 SELECT を省く）。省略時は date のデフォルトセッションへ。
 */
export function persistEntry(
  db: Db,
  input: { date: string; sessionId?: number; raw: string; converted: string },
): ResultAsync<SavedEntry, DbError> {
  return saveSnapshot(db, { ...input, chunks: chunkText(input.converted) });
}

/**
 * セッション指定の自動保存（web サーバの PUT entry 用）。チャンク化を内包し、
 * セッション未存在は Err でなく null で返す（呼び出し側が 404 に写せるように）。
 */
export function saveSessionEntry(
  db: Db,
  sessionId: number,
  input: { raw: string; converted: string },
): ResultAsync<SavedEntry | null, DbError> {
  return getSession(db, sessionId).andThen((session) =>
    session === null
      ? okAsync(null)
      : saveSnapshot(db, {
          date: session.date,
          sessionId: session.id,
          raw: input.raw,
          converted: input.converted,
          chunks: chunkText(input.converted),
        }),
  );
}
