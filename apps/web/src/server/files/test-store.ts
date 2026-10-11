import type { FileStore, MultipartPart } from "@zakki/web/server/files/store.ts";

/**
 * テスト用のインメモリ {@link FileStore}（issue #157）。R2 の binding は
 * ローカルで再現できないため、multipart の組み立てだけを同じ意味論で模す。
 * プロダクションコードからは import しない。
 */
type MultipartRecord = { key: string; uploadId: string };

export function memoryFileStore(): FileStore & {
  objects: Map<string, Uint8Array>;
  created: MultipartRecord[];
  aborted: MultipartRecord[];
} {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const created: MultipartRecord[] = [];
  const aborted: MultipartRecord[] = [];
  let seq = 0;

  return {
    objects,
    created,
    aborted,
    createMultipart(_retention, key) {
      seq += 1;
      const uploadId = `upload-${seq}`;
      uploads.set(`${key}\u0000${uploadId}`, new Map());
      created.push({ key, uploadId });
      return Promise.resolve({ uploadId });
    },
    uploadPart(_retention, key, uploadId, partNumber, body) {
      const parts = uploads.get(`${key}\u0000${uploadId}`);
      if (parts === undefined) throw new Error(`未知の uploadId: ${uploadId}`);
      parts.set(partNumber, new Uint8Array(body));
      return Promise.resolve({ etag: `etag-${partNumber}` });
    },
    completeMultipart(_retention, key, uploadId, parts: readonly MultipartPart[]) {
      const stored = uploads.get(`${key}\u0000${uploadId}`);
      if (stored === undefined) throw new Error(`未知の uploadId: ${uploadId}`);
      const chunks = parts
        .toSorted((a, b) => a.partNumber - b.partNumber)
        .map((p) => stored.get(p.partNumber) ?? new Uint8Array());
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        joined.set(c, offset);
        offset += c.length;
      }
      objects.set(key, joined);
      uploads.delete(`${key}\u0000${uploadId}`);
      return Promise.resolve();
    },
    abortMultipart(_retention, key, uploadId) {
      const uploadKey = `${key}\u0000${uploadId}`;
      if (uploads.delete(uploadKey)) {
        aborted.push({ key, uploadId });
      }
      return Promise.resolve();
    },
    get(_retention, key) {
      return Promise.resolve(objects.get(key) ?? null);
    },
    delete(_retention, key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}
