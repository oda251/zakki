/**
 * ファイル実体（バイト列）の保管先の抽象（issue #157）。
 *
 * サーバは中継のみ: multipart の組み立て・完了・読み出し・削除を仲介するだけで、
 * 暗号化・復号には一切関与しない（クライアントが暗号化済みのバイト列を送る。
 * depcruise `web-server-no-decrypt-capability`）。
 */

import { FILE_RETENTIONS, type FileRetention } from "@zakki/core/file/upload.ts";

/** R2 multipart upload の完了に渡す 1 part（part 番号は 1 始まり）。 */
export interface MultipartPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface FileStore {
  createMultipart(retention: FileRetention, key: string): Promise<{ uploadId: string }>;
  uploadPart(
    retention: FileRetention,
    key: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer,
  ): Promise<{ etag: string }>;
  completeMultipart(
    retention: FileRetention,
    key: string,
    uploadId: string,
    parts: readonly MultipartPart[],
  ): Promise<void>;
  abortMultipart(retention: FileRetention, key: string, uploadId: string): Promise<void>;
  get(retention: FileRetention, key: string): Promise<Uint8Array | null>;
  delete(retention: FileRetention, key: string): Promise<void>;
}

/**
 * `accountId` / `fileId` にパス区切り・親ディレクトリ参照が紛れていないかを検査する。
 * 混入を許すと、細工した fileId で他アカウントのオブジェクトキーを踏める
 * （D7 が守ろうとしているアカウント分離が崩れる）。
 */
function assertSafePathSegment(value: string, label: string): void {
  if (value === "" || value.includes("/") || value.includes("..")) {
    throw new Error(`不正な ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * R2 のオブジェクトキー。`accounts/<accountId>/<retention>/<fileId>` の形に固定することで、
 * アカウントをまたいだ参照を構造的に不可能にする（他アカウントの fileId を
 * 知っていても、自分の accountId 配下のキーしか組み立てられない）。
 */
export function objectKeyFor(accountId: string, fileId: string, retention: FileRetention): string {
  assertSafePathSegment(accountId, "accountId");
  assertSafePathSegment(fileId, "fileId");
  if (!FILE_RETENTIONS.includes(retention)) {
    throw new Error(`不正な retention: ${JSON.stringify(retention)}`);
  }
  return `accounts/${accountId}/${retention}/${fileId}`;
}

/** Cloudflare R2 の multipart upload ハンドル（使う面だけの最小 interface）。 */
export interface R2MultipartUploadLike {
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ etag: string }>;
  complete(parts: readonly MultipartPart[]): Promise<unknown>;
  abort(): Promise<void>;
}

/** R2 の get が返すオブジェクト（本体だけ使う）。 */
export interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Cloudflare R2 binding の最小面（issue #157）。`@cloudflare/workers-types` を
 * 依存に足さず、`worker-env.ts` の `ServiceBinding` と同じ流儀で使う API だけを
 * 自前で宣言する。実 binding はローカルで検証できないため、アダプタ（{@link r2FileStore}）は
 * ここへの委譲だけに留める。
 * 出典: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
 */
export interface R2BucketLike {
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  /**
   * 進行中の multipart upload のハンドルを uploadId から再構成する。R2 の
   * multipart は part ごとに別リクエスト（= 別 Worker invocation）で来るため、
   * `createMultipartUpload` が返したハンドルをその場に持ち越せない。
   */
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
}

/** R2 binding のアダプタ。マルチユーザ Workers 配備（issue #134）で使う。 */
export function r2FileStore(buckets: Record<FileRetention, R2BucketLike>): FileStore {
  return {
    async createMultipart(retention, key) {
      return await buckets[retention].createMultipartUpload(key);
    },
    async uploadPart(retention, key, uploadId, partNumber, body) {
      return await buckets[retention]
        .resumeMultipartUpload(key, uploadId)
        .uploadPart(partNumber, body);
    },
    async completeMultipart(retention, key, uploadId, parts) {
      await buckets[retention].resumeMultipartUpload(key, uploadId).complete(parts);
    },
    async abortMultipart(retention, key, uploadId) {
      try {
        await buckets[retention].resumeMultipartUpload(key, uploadId).abort();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("(10024)")) throw error;
      }
    },
    async get(retention, key) {
      const object = await buckets[retention].get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
    async delete(retention, key) {
      await buckets[retention].delete(key);
    },
  };
}
