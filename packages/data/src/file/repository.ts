import { and, desc, eq, gte } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import { AAD } from "@zakki/core/crypto/aad.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import type { Chunk, ZakkiFile } from "@zakki/data/db/schema.ts";
import { chunks, files } from "@zakki/data/db/schema.ts";

/**
 * アップロードファイル（issue #157）のリポジトリ。
 *
 * `files` 行はアップロードのメタデータ、実体（blob チャンクとの結びつけ）は
 * `chunks.kind='blob'` 行が `file_id` で参照する（docs/tmp/157-file-upload.md）。
 */

/**
 * blob チャンクの position 帯の下限。テキスト草稿（`saveChildren` の投影対象、
 * 0 始まり）と同じ position 空間を共有すると、テキスト保存のたびに「どの草稿にも
 * 対応しない行」として blob チャンクが消えてしまう。帯を分けて衝突を避ける
 * （docs/tmp/157-file-upload.md「blob チャンクの position」）。
 */
export const BLOB_POSITION_BASE = 1_000_000;

export interface FileInsertInput {
  name: string;
  extension: string;
  encryption: "none" | "password";
  objectKey: string;
  size: number;
  partSize: number;
}

/** 暗号 ON なら name を復号して平文 ZakkiFile を返す */
function decFile(crypto: CryptoContext | undefined, row: ZakkiFile): ZakkiFile {
  if (crypto === undefined) return row;
  return { ...row, name: crypto.decString(row.name, AAD.fileName) };
}

/** files 行を作る。暗号 ON なら name を AEAD で暗号化して保存する */
export function insertFile(
  db: Db,
  input: FileInsertInput,
  now: string = new Date().toISOString(),
): ResultAsync<ZakkiFile, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const [row] = await db
      .insert(files)
      .values({
        name: crypto === undefined ? input.name : crypto.encString(input.name, AAD.fileName),
        extension: input.extension,
        encryption: input.encryption,
        objectKey: input.objectKey,
        size: input.size,
        partSize: input.partSize,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (row === undefined) {
      throw new Error("file の作成に失敗しました");
    }
    return decFile(crypto, row);
  });
}

/** id 指定で files 行を読む（復号済み）。無ければ null */
export function getFile(db: Db, id: number): ResultAsync<ZakkiFile | null, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
    return row === undefined ? null : decFile(crypto, row);
  });
}

/** blob チャンク id → files 行（復号済み）の対応。TUI/表示側が chunk 一覧と突き合わせる材料 */
export function listFilesByChunk(db: Db): ResultAsync<Map<number, ZakkiFile>, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const rows = await db
      .select({ chunkId: chunks.id, file: files })
      .from(chunks)
      .innerJoin(files, eq(chunks.fileId, files.id));
    const map = new Map<number, ZakkiFile>();
    for (const row of rows) {
      map.set(row.chunkId, decFile(crypto, row.file));
    }
    return map;
  });
}

/**
 * `kind='blob'` のチャンクを作る（アップロード完了後、files 行に紐づける）。
 * position は {@link BLOB_POSITION_BASE} 以上の帯で、同じ親の既存 blob チャンクの
 * 最大 position + 1（テキスト草稿の position 空間と衝突しない）。
 */
export function createBlobChunk(
  db: Db,
  parentId: number,
  fileId: number,
  now: string = new Date().toISOString(),
): ResultAsync<Chunk, DbError> {
  return tryDbAsync(() =>
    db.transaction(async (tx) => {
      const [maxRow] = await tx
        .select({ position: chunks.position })
        .from(chunks)
        .where(and(eq(chunks.parentId, parentId), gte(chunks.position, BLOB_POSITION_BASE)))
        .orderBy(desc(chunks.position))
        .limit(1);
      const position = maxRow === undefined ? BLOB_POSITION_BASE : maxRow.position + 1;

      const [row] = await tx
        .insert(chunks)
        .values({
          parentId,
          position,
          kind: "blob",
          fileId,
          content: "",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) {
        throw new Error("blob チャンクの作成に失敗しました");
      }
      return row;
    }),
  );
}
