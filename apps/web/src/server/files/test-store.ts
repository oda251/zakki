import type { FileStore, MultipartPart } from "@zakki/web/server/files/store.ts";

/**
 * テスト用のインメモリ {@link FileStore}（issue #157）。R2 の binding は
 * ローカルで再現できないため、multipart の組み立てだけを同じ意味論で模す。
 * プロダクションコードからは import しない。
 */
export function memoryFileStore(): FileStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  let seq = 0;

  return {
    objects,
    createMultipart(key) {
      seq += 1;
      const uploadId = `upload-${seq}`;
      uploads.set(`${key}\u0000${uploadId}`, new Map());
      return Promise.resolve({ uploadId });
    },
    uploadPart(key, uploadId, partNumber, body) {
      const parts = uploads.get(`${key}\u0000${uploadId}`);
      if (parts === undefined) throw new Error(`未知の uploadId: ${uploadId}`);
      parts.set(partNumber, new Uint8Array(body));
      return Promise.resolve({ etag: `etag-${partNumber}` });
    },
    completeMultipart(key, uploadId, parts: readonly MultipartPart[]) {
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
    get(key) {
      return Promise.resolve(objects.get(key) ?? null);
    },
    delete(key) {
      objects.delete(key);
      return Promise.resolve();
    },
  };
}
