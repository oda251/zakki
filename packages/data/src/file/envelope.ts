import { eq } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import { toBytes } from "@zakki/data/db/blob.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { fileKeyEnvelopes } from "@zakki/data/db/schema.ts";

/**
 * ファイル暗号鍵（FEK）の封筒（issue #157）のリポジトリ。
 *
 * チャンクの DEK 封筒（`crypto/envelopes.ts`）と同じ「サーバは封筒を保存・配布する
 * だけで開けない」役割だが、鍵とテーブルは別（DEK と FEK を混ぜると、TUI の
 * `unlockOrSetup` の初回判定やパスワード変更の再 wrap が巻き添えになる。
 * schema.ts の fileKeyEnvelopes の注記）。
 *
 * FEK は単一（封筒 1 本 = id=1 固定）で、パスワード変更は「同じ FEK を新しい KEK で
 * 包み直した封筒」への上書きになる（#157 決定表）。
 */

/** wrapped 済み FEK 封筒（バイト列は BLOB として保存） */
export interface FileKeyEnvelopeRecord {
  readonly wrappedFek: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly kdfOps: number;
  readonly kdfMem: number;
}

/** 封筒の単一行 id。FEK は復元可能な鍵が 1 種類だけなので、行も 1 行で足りる */
const ENVELOPE_ID = 1;

/** wrapped 済み FEK 封筒を読む。未設定（初回）なら null */
export function getFileKeyEnvelope(db: Db): ResultAsync<FileKeyEnvelopeRecord | null, DbError> {
  return tryDbAsync(async () => {
    const [row] = await db
      .select()
      .from(fileKeyEnvelopes)
      .where(eq(fileKeyEnvelopes.id, ENVELOPE_ID))
      .limit(1);
    if (row === undefined) return null;
    return {
      wrappedFek: toBytes(row.wrappedFek),
      kdfSalt: toBytes(row.kdfSalt),
      kdfOps: row.kdfOps,
      kdfMem: row.kdfMem,
    };
  });
}

/** wrapped 済み FEK 封筒を保存する。既にある封筒は上書き（id=1 の upsert） */
export function putFileKeyEnvelope(
  db: Db,
  envelope: FileKeyEnvelopeRecord,
  now: string = new Date().toISOString(),
): ResultAsync<FileKeyEnvelopeRecord, DbError> {
  return tryDbAsync(async () => {
    const row: {
      wrappedFek: Buffer;
      kdfSalt: Buffer;
      kdfOps: number;
      kdfMem: number;
    } = {
      wrappedFek: Buffer.from(envelope.wrappedFek),
      kdfSalt: Buffer.from(envelope.kdfSalt),
      kdfOps: envelope.kdfOps,
      kdfMem: envelope.kdfMem,
    };
    const [inserted] = await db
      .insert(fileKeyEnvelopes)
      .values({
        id: ENVELOPE_ID,
        ...row,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: fileKeyEnvelopes.id,
        set: row,
      })
      .returning();
    if (inserted === undefined) {
      throw new Error("FEK 封筒の保存に失敗しました");
    }
    return {
      wrappedFek: toBytes(inserted.wrappedFek),
      kdfSalt: toBytes(inserted.kdfSalt),
      kdfOps: inserted.kdfOps,
      kdfMem: inserted.kdfMem,
    };
  });
}