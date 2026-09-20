/**
 * API リクエストボディの valibot スキーマ（SSOT、issue #49）。
 * server はこのスキーマで検証し（server/parse.ts の parseBody）、
 * client は派生型（v.InferInput）で送信リテラルの形を縛る。
 * レスポンス側の型は api-types.ts（@zakki/data の re-export）を参照。
 */
import * as v from "valibot";

// chunks 書込み・読取系のスキーマは RxDB replication への移行で撤去済み（#44 → #45）。
// かな漢字変換のスキーマも #26 でクライアント wasm 実行へ移設し撤去した。

// --- replication（server/routes/replication.ts, issue #42） ---

/**
 * wire doc: id/updatedAt/_deleted は必須。他フィールドは暗号文（#28）なので
 * 中身は検査せず passthrough する（looseObject）。
 */
export const WireDocSchema = v.looseObject({
  id: v.string(),
  updatedAt: v.string(),
  _deleted: v.boolean(),
});

/** POST /api/replication/:collection/pull */
export const ReplicationPullSchema = v.object({
  checkpoint: v.nullable(v.object({ id: v.string(), updatedAt: v.string() })),
  limit: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/** POST /api/replication/:collection/push */
export const ReplicationPushSchema = v.object({
  rows: v.array(
    v.object({
      assumedMasterState: v.nullable(WireDocSchema),
      newDocumentState: WireDocSchema,
    }),
  ),
});

// --- crypto envelopes（server/routes/crypto.ts, issue #43） ---

/**
 * GET /api/crypto/envelopes の封筒 1 件（kind で判別する discriminated union）。
 * クライアントが受信側で検証するレスポンススキーマ（平文 DEK・PRF 出力は含まれない。
 * wrappedDek/kdfSalt は base64 ORIGINAL）。
 * keyfile 封筒はサーバ端末ローカル専用のため wire には現れない。
 */
export const KdfCryptoEnvelopeSchema = v.object({
  kind: v.picklist(["passphrase", "recovery"]),
  wrappedDek: v.string(),
  kdfSalt: v.string(),
  kdfOps: v.pipe(v.number(), v.integer(), v.minValue(1)),
  kdfMem: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/**
 * passkey 封筒（issue #103）。KEK は PRF 出力から決定的に導出される
 * （`deriveKekFromPrf`）ため kdf メタを持たず、代わりにどのクレデンシャルで
 * 開けるかの credentialId を運ぶ。
 */
export const PasskeyCryptoEnvelopeSchema = v.object({
  kind: v.literal("passkey"),
  wrappedDek: v.string(),
  credentialId: v.string(),
});

export const CryptoEnvelopeSchema = v.variant("kind", [
  KdfCryptoEnvelopeSchema,
  PasskeyCryptoEnvelopeSchema,
]);

export const CryptoEnvelopesResponseSchema = v.object({
  envelopes: v.array(CryptoEnvelopeSchema),
});

export type CryptoEnvelope = v.InferOutput<typeof CryptoEnvelopeSchema>;
export type KdfCryptoEnvelope = v.InferOutput<typeof KdfCryptoEnvelopeSchema>;
export type PasskeyCryptoEnvelope = v.InferOutput<typeof PasskeyCryptoEnvelopeSchema>;

/**
 * POST /api/crypto/envelopes/passkey のボディ。クライアントで wrap 済みの封筒
 * （wrappedDek: base64 ORIGINAL）と credentialId だけを受ける。
 * **平文 DEK・PRF 出力は wire に流れない**（wrap はクライアントで行う, #28/#103）。
 */
/**
 * ファイル暗号鍵（FEK）の封筒（issue #157）。チャンクの DEK 封筒（CryptoEnvelope）と
 * は**鍵・テーブルが別**で、封筒は常に 1 本（パスワード変更は再 wrap の上書き）。
 * wrappedFek / kdfSalt は base64（ORIGINAL）。クライアントが受信側で検証する
 * レスポンス形と、PUT のボディ形を兼ねる（サーバは wrap/unwrap しない, #28）。
 */
export const FileEnvelopeSchema = v.object({
  wrappedFek: v.string(),
  kdfSalt: v.string(),
  kdfOps: v.pipe(v.number(), v.integer(), v.minValue(1)),
  kdfMem: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type FileEnvelope = v.InferOutput<typeof FileEnvelopeSchema>;

/**
 * POST /api/files/:fileId/multipart/:uploadId/complete のボディ。
 * R2 multipart の完了は「part 番号（1 始まり）と R2 が発行した etag」の一覧を
 * 渡す必要がある（R2 はサーバ側で part ごとの etag を照合する）。
 * part は 1 つ以上（無音声の 0 part 完了はあり得ない）。
 */
export const FileMultipartPartSchema = v.object({
  partNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  etag: v.pipe(v.string(), v.minLength(1)),
});

export const FileMultipartCompleteSchema = v.object({
  parts: v.pipe(v.array(FileMultipartPartSchema), v.minLength(1)),
});

export const PasskeyEnvelopePutSchema = v.object({
  wrappedDek: v.pipe(v.string(), v.minLength(1)),
  // WebAuthn の credential id は base64url（no padding）。ここで形を縛るのは、
  // 解釈できない id が 1 本でも保存されると allowCredentials の組み立てで巻き添えになり、
  // 封筒が複数ある状況では「全部のパスキーが使えない」に化けるため（#120）
  credentialId: v.pipe(v.string(), v.minLength(1), v.regex(/^[A-Za-z0-9_-]+$/)),
});

// --- 派生型（client の送信形はここから得る） ---
// chunk 書込み系（#44 RxDB 移行）・変換系（#26 wasm 移設）の派生型は撤去済み。
