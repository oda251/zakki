/**
 * ファイルのアップロード・ダウンロード（issue #157 §4 / §5）。
 *
 * クライアントが行うのは:
 * 1. part 分割: 平文をサーバ指定の partSize に切り分ける（core/file/upload.ts の partRanges）
 * 2. part 暗号化: `fek` が与えられたら part ごとに AAD 束縛の AEAD で暗号化
 *    （core/crypto/file-key.ts の encryptPart）。無ければ（encryption="none"）平文のまま
 * 3. 中継サーバの multipart endpoint へ流し、完了する（サーバは R2 へ書くだけ）
 * 4. ローカル RxDB に files doc（メタデータ）と blob チャンク doc を作る
 *
 * FEK はこのモジュールを呼ぶ側（password.ts の unlockFek / setFilePassword）が
 * 持つ。メモリだけに載せ、永続化しない（#157 §5）。
 */
import { BLOB_POSITION_BASE, partRanges, validateUploadSize } from "@zakki/core/file/upload.ts";
import { decryptPart, encryptPart, PART_OVERHEAD_BYTES } from "@zakki/core/crypto/file-key.ts";
import { splitFilename } from "@zakki/core/file/name.ts";
import type { ChunkDoc, FileDoc, ZakkiDatabase } from "@zakki/web/client/db/database.ts";
import { newDocId } from "@zakki/web/client/db/ids.ts";
import { API_BASE } from "@zakki/web/shared/api-base.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";

/** File の最小面（テストが `{ name, size, slice() }` の偽物を注入できるように絞る） */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  slice(start?: number, end?: number, contentType?: string): Blob;
}

export interface UploadFileOptions {
  db: ZakkiDatabase;
  parentId: string;
  file: FileLike;
  /** 非 null なら part をこの FEK で暗号化する（encryption="password"） */
  fek: Uint8Array | null;
  fetchFn?: FetchLike;
}

export interface UploadedFile {
  file: FileDoc;
  chunk: ChunkDoc;
}

const nowIso = (): string => new Date().toISOString();

/** 同じ親の blob チャンクの最大 position + 1。無ければ {@link BLOB_POSITION_BASE} から始める */
async function nextBlobPosition(db: ZakkiDatabase, parentId: string): Promise<number> {
  const blobs = await db.chunks.find({ selector: { parentId, kind: "blob" } }).exec();
  const max = blobs.reduce((m, d) => Math.max(m, d.position), 0);
  return max >= BLOB_POSITION_BASE ? max + 1 : BLOB_POSITION_BASE;
}

/** multipart の完了レスポンス（予期しない形を型で縛らないため構造は最小） */
interface BeginResponse {
  uploadId: string;
  partSize: number;
  objectKey: string;
}

interface PartResponse {
  etag: string;
}

async function jsonOrThrow<T>(res: Response, message: string): Promise<T> {
  if (!res.ok) throw new Error(message);
  // oxlint-disable-next-line typescript/consistent-type-assertions -- HTTP JSON は untyped。サーバの API 契約（api-schemas）と 1:1 の読み替え境界
  return (await res.json()) as T;
}

export async function uploadFile(opts: UploadFileOptions): Promise<UploadedFile> {
  const fetchFn = opts.fetchFn ?? fetch;
  const size = validateUploadSize(opts.file.size).match(
    (s) => s,
    (e) => {
      throw new Error(e.message);
    },
  );
  const { name, extension } = splitFilename(opts.file.name);
  const fileId = newDocId();

  const begin = await jsonOrThrow<BeginResponse>(
    await fetchFn(`${API_BASE}/files/${fileId}/multipart`, { method: "POST" }),
    "multipart の開始に失敗しました",
  );

  const uploadBody = async (): Promise<{ partNumber: number; etag: string }[]> => {
    const parts: { partNumber: number; etag: string }[] = [];
    for (const range of partRanges(size, begin.partSize)) {
      const plaintext = new Uint8Array(
        await opts.file.slice(range.start, range.end).arrayBuffer(),
      );
      const payload =
        opts.fek === null ? plaintext : encryptPart(opts.fek, range.index, plaintext);
      const p = await jsonOrThrow<PartResponse>(
        await fetchFn(
          `${API_BASE}/files/${fileId}/multipart/${begin.uploadId}/parts/${range.index}`,
          { method: "PUT", body: Uint8Array.from(payload) },
        ),
        "part のアップロードに失敗しました",
      );
      parts.push({ partNumber: range.index, etag: p.etag });
    }
    return parts;
  };
  const uploaded = await uploadBody();
  await jsonOrThrow<{ ok: boolean }>(
    await fetchFn(`${API_BASE}/files/${fileId}/multipart/${begin.uploadId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: uploaded.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
      }),
    }),
    "multipart の完了に失敗しました",
  );

  const now = nowIso();
  const fileDoc: FileDoc = {
    id: fileId,
    name,
    extension,
    encryption: opts.fek === null ? "none" : "password",
    objectKey: begin.objectKey,
    size,
    partSize: begin.partSize,
    updatedAt: now,
  };
  await opts.db.files.insert(fileDoc);

  const chunkDoc: ChunkDoc = {
    id: newDocId(),
    parentId: opts.parentId,
    position: await nextBlobPosition(opts.db, opts.parentId),
    kind: "blob",
    fileId: fileId,
    content: "",
    date: null,
    polarity: null,
    updatedAt: now,
  };
  await opts.db.chunks.insert(chunkDoc);

  return { file: fileDoc, chunk: chunkDoc };
}

export interface DownloadFileOptions {
  file: FileDoc;
  /** 非 null で part を復号する。暗号化ファイルを開くときは unlockFek の結果を渡す */
  fek: Uint8Array | null;
  fetchFn?: FetchLike;
}

export async function downloadFile(opts: DownloadFileOptions): Promise<Uint8Array> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${API_BASE}/files/${opts.file.id}`);
  if (!res.ok) throw new Error("ファイルの取得に失敗しました");
  const stored = new Uint8Array(await res.arrayBuffer());
  if (opts.fek === null) return stored;

  // 暗号文は「平文 part + オーバーヘッド（nonce+tag 40B）」の concat。平文サイズと
  // partSize から part ごとの暗号文長が一意に決まるので、順番に切り出して
  // 復号しながら合成する（part 番号は AAD 束縛されており、並び替えは検出される）
  const merged: number[] = [];
  let offset = 0;
  for (const range of partRanges(opts.file.size, opts.file.partSize)) {
    const cipherLen = range.end - range.start + PART_OVERHEAD_BYTES;
    const plain = decryptPart(opts.fek, range.index, stored.subarray(offset, offset + cipherLen));
    for (const byte of plain) merged.push(byte);
    offset += cipherLen;
  }
  return Uint8Array.from(merged);
}