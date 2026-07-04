import { and, asc, eq, isNull } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { Session } from "@zakki/data/db/schema.ts";
import { sessions, sessionTags } from "@zakki/data/db/schema.ts";

/** 暗号 ON なら name を復号して平文 Session を返す。NULL（デフォルト）はそのまま */
function decSession(crypto: CryptoContext | undefined, s: Session): Session {
  if (crypto === undefined || s.name === null) return s;
  return { ...s, name: crypto.decString(s.name, "session.name") };
}

function encName(crypto: CryptoContext | undefined, name: string): string {
  return crypto === undefined ? name : crypto.encString(name, "session.name");
}

/** セッションタグ名 → (name, fingerprint)。暗号 OFF は fingerprint = 平文名 */
function encTag(
  crypto: CryptoContext | undefined,
  name: string,
): { name: string; nameFingerprint: string } {
  if (crypto === undefined) return { name, nameFingerprint: name };
  return {
    name: crypto.encString(name, "sessionTag.name"),
    nameFingerprint: crypto.fingerprint(name),
  };
}

/** タグ込みのセッション（一覧表示用） */
export interface SessionWithTags extends Session {
  tags: string[];
}

/** 名前の trim + 空チェック。空はデフォルトセッション（name = NULL）専用のため拒否 */
function requireSessionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("セッション名は空にできません（デフォルトセッションは name = NULL）");
  }
  return trimmed;
}

/**
 * 日付のデフォルトセッション（name = NULL、1 日 1 件）を読む。無ければ null。
 * 「デフォルトセッションとは何か」（name IS NULL）の判定はここに封じる。
 */
export function getDefaultSession(db: Db, date: string): ResultAsync<Session | null, DbError> {
  return tryDbAsync(async () => {
    const [existing] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.date, date), isNull(sessions.name)))
      .limit(1);
    return existing ?? null;
  });
}

/**
 * 当日のデフォルトセッションを取得・なければ作成する。
 * TUI の日付ベース管理の実体。冪等。
 */
export function getOrCreateDefaultSession(
  db: Db,
  date: string,
  now: string = new Date().toISOString(),
): ResultAsync<Session, DbError> {
  return getDefaultSession(db, date).andThen((existing) =>
    tryDbAsync(async () => {
      if (existing !== null) return existing;
      const [created] = await db
        .insert(sessions)
        .values({ name: null, date, createdAt: now, updatedAt: now })
        .returning();
      if (created === undefined) {
        throw new Error("デフォルトセッションの作成に失敗しました");
      }
      return created;
    }),
  );
}

/** 名前付きセッションを作成する。同日に複数持てる。name は空にできない */
export function createSession(
  db: Db,
  input: { name: string; date: string },
  now: string = new Date().toISOString(),
): ResultAsync<Session, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const name = requireSessionName(input.name);
    const [created] = await db
      .insert(sessions)
      .values({ name: encName(crypto, name), date: input.date, createdAt: now, updatedAt: now })
      .returning();
    if (created === undefined) {
      throw new Error("セッションの作成に失敗しました");
    }
    return decSession(crypto, created);
  });
}

export function getSession(db: Db, id: number): ResultAsync<Session | null, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row === undefined ? null : decSession(crypto, row);
  });
}

/** 全セッションをタグ込みで返す（date 昇順・同日はデフォルト→id 順） */
export function listSessions(db: Db): ResultAsync<SessionWithTags[], DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const rows = await db.select().from(sessions).orderBy(asc(sessions.date), asc(sessions.id));
    const tagRows = await db.select().from(sessionTags).orderBy(asc(sessionTags.id));
    const tagsBySession = new Map<number, string[]>();
    for (const t of tagRows) {
      const name = crypto === undefined ? t.name : crypto.decString(t.name, "sessionTag.name");
      const list = tagsBySession.get(t.sessionId) ?? [];
      list.push(name);
      tagsBySession.set(t.sessionId, list);
    }
    return rows.map((s) => ({ ...decSession(crypto, s), tags: tagsBySession.get(s.id) ?? [] }));
  });
}

/** セッション名を変更する。デフォルトセッションに適用すると名前付きへ昇格する */
export function renameSession(
  db: Db,
  id: number,
  name: string,
  now: string = new Date().toISOString(),
): ResultAsync<void, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    await db
      .update(sessions)
      .set({ name: encName(crypto, requireSessionName(name)), updatedAt: now })
      .where(eq(sessions.id, id));
  });
}

/** セッションを削除する。entry / chunks / session_tags は FK cascade で連鎖削除 */
export function deleteSession(db: Db, id: number): ResultAsync<void, DbError> {
  return tryDbAsync(async () => {
    await db.delete(sessions).where(eq(sessions.id, id));
  });
}

/**
 * セッションのユーザ明示タグを全置換する（重複・空白のみは除去）。
 * 自動タグ（tags / chunk_tags）とは独立で、解析パスに影響しない。
 */
export function setSessionTags(
  db: Db,
  sessionId: number,
  names: string[],
  now: string = new Date().toISOString(),
): ResultAsync<void, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(() =>
    db.transaction(async (tx) => {
      await tx.delete(sessionTags).where(eq(sessionTags.sessionId, sessionId));
      const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ""))];
      if (unique.length === 0) return;
      await tx
        .insert(sessionTags)
        .values(unique.map((name) => ({ sessionId, ...encTag(crypto, name), createdAt: now })));
    }),
  );
}
