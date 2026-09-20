import { err, ok, type Result } from "neverthrow";
import { PART_OVERHEAD_BYTES } from "@zakki/core/crypto/file-key.ts";

/**
 * ファイルアップロードのサイズ制約・part 分割（issue #157）。
 *
 * R2 multipart upload に載せるため、平文を固定サイズの part へ切り分けてから
 * {@link import("@zakki/core/crypto/file-key.ts").encryptPart} で part ごとに暗号化する。
 * part の境界は暗号化の前後で 1:1 に対応するため、平文の range 計算と
 * 暗号文サイズの計算をここで分離しておく。
 */

/** 1 ファイルあたりのアップロード上限（issue #157 §4）。9 GiB。 */
export const MAX_UPLOAD_BYTES = 9 * 1024 ** 3;

/**
 * 1 part（暗号化後）の上限バイト数。Cloudflare Workers のリクエストボディ上限
 * （Free/Pro プランで 100 MB, https://developers.cloudflare.com/workers/platform/limits/）
 * に合わせる。中継サーバは part を Worker 経由で R2 へ流すため、これを超える part は送れない。
 */
export const MAX_PART_BYTES = 100 * 1024 ** 2;

/**
 * 既定の平文 part サイズ（32 MiB）。暗号化オーバーヘッド
 * （{@link PART_OVERHEAD_BYTES}）を足しても {@link MAX_PART_BYTES} に収まる範囲で、
 * part 数（= R2 multipart の API 呼び出し回数）を抑えるためになるべく大きく取る。
 */
export const DEFAULT_PART_BYTES = 32 * 1024 ** 2;

/**
 * blob チャンク（アップロードファイル, issue #157）の position 帯の下限。
 *
 * テキスト草稿は 0 始まりの position 空間に住み、`saveChildren`（テキスト保存の
 * 投影）は「どの草稿にも対応しない行」を消し去る。blob チャンクを同じ空間に置くと
 * テキストを保存するたびに消えてしまうため、専用の帯に置き、投影からは kind で
 * 除外する（`unique(parent_id, position)` を壊さず共存する。docs/tmp/157-file-upload.md）。
 *
 * 表示は「テキスト行の後ろに並ぶ」（受容）。
 */
export const BLOB_POSITION_BASE = 1_000_000;

export interface UploadSizeError {
  readonly type: "upload-size-error";
  readonly message: string;
}

/** アップロードサイズが 1 バイト以上 {@link MAX_UPLOAD_BYTES} 以下かを検証する。 */
export function validateUploadSize(totalBytes: number): Result<number, UploadSizeError> {
  if (totalBytes <= 0) {
    return err({ type: "upload-size-error", message: "ファイルが空です" });
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return err({
      type: "upload-size-error",
      message: `ファイルサイズが上限（${MAX_UPLOAD_BYTES} バイト）を超えています`,
    });
  }
  return ok(totalBytes);
}

/** R2 multipart の 1 part に対応する平文の範囲。`index` は 1 始まり、`[start, end)` の半開区間。 */
export interface PartRange {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/**
 * 平文全体を `partBytes` ごとの part に分割する。最後の part だけ端数で短くなる
 * （割り切れる場合は端数の part を作らない）。
 */
export function partRanges(totalBytes: number, partBytes: number): PartRange[] {
  const ranges: PartRange[] = [];
  let start = 0;
  let index = 1;
  while (start < totalBytes) {
    const end = Math.min(start + partBytes, totalBytes);
    ranges.push({ index, start, end });
    start = end;
    index += 1;
  }
  return ranges;
}

/** 平文 part サイズから暗号化後の part サイズを求める。 */
export function ciphertextPartSize(partSize: number): number {
  return partSize + PART_OVERHEAD_BYTES;
}
