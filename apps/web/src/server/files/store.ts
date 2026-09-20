/**
 * ファイル実体（バイト列）の保管先の抽象（issue #157）。
 *
 * サーバは中継のみ: multipart の組み立て・完了・読み出し・削除を仲介するだけで、
 * 暗号化・復号には一切関与しない（クライアントが暗号化済みのバイト列を送る。
 * depcruise `web-server-no-decrypt-capability`）。
 */

/** R2 multipart upload の完了に渡す 1 part（part 番号は 1 始まり）。 */
export interface MultipartPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface FileStore {
  createMultipart(key: string): Promise<{ uploadId: string }>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer,
  ): Promise<{ etag: string }>;
  completeMultipart(key: string, uploadId: string, parts: readonly MultipartPart[]): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
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
 * R2 のオブジェクトキー。`accounts/<accountId>/<fileId>` の形に固定することで、
 * アカウントをまたいだ参照を構造的に不可能にする（他アカウントの fileId を
 * 知っていても、自分の accountId 配下のキーしか組み立てられない）。
 */
export function objectKeyFor(accountId: string, fileId: string): string {
  assertSafePathSegment(accountId, "accountId");
  assertSafePathSegment(fileId, "fileId");
  return `accounts/${accountId}/${fileId}`;
}

/** Cloudflare R2 の multipart upload ハンドル（使う面だけの最小 interface）。 */
export interface R2MultipartUploadLike {
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ etag: string }>;
  complete(parts: readonly MultipartPart[]): Promise<unknown>;
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
export function r2FileStore(bucket: R2BucketLike): FileStore {
  return {
    async createMultipart(key) {
      return await bucket.createMultipartUpload(key);
    },
    async uploadPart(key, uploadId, partNumber, body) {
      return await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
    },
    async completeMultipart(key, uploadId, parts) {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
    },
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
