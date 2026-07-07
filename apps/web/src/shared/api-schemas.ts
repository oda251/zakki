/**
 * API リクエストボディの valibot スキーマ（SSOT、issue #49）。
 * server はこのスキーマで検証し（server/parse.ts の parseBody）、
 * client は派生型（v.InferInput）で送信リテラルの形を縛る。
 * レスポンス側の型は api-types.ts（@zakki/data の re-export）を参照。
 */
import * as v from "valibot";

// chunks 書込み・読取系のスキーマは RxDB replication への移行で撤去済み（#44 → #45）

// --- conversion（server/routes/convert.ts） ---

/** POST /api/convert */
export const ConvertSchema = v.object({
  kana: v.pipe(v.string(), v.minLength(1)),
  leftContext: v.optional(v.string()),
});

/** POST /api/conversion/cache */
export const SaveConversionSchema = v.object({ kana: v.string(), converted: v.string() });

/** POST /api/conversion/corrections */
export const SaveCorrectionSchema = v.object({ kana: v.string(), chosen: v.string() });

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
 * GET /api/crypto/envelopes の封筒 1 件。クライアントが受信側で検証する
 * レスポンススキーマ（平文 DEK は含まれない。wrappedDek/kdfSalt は base64 ORIGINAL）。
 * keyfile 封筒はサーバ端末ローカル専用のため wire には現れない。
 */
export const CryptoEnvelopeSchema = v.object({
  kind: v.picklist(["passphrase", "recovery"]),
  wrappedDek: v.string(),
  kdfSalt: v.string(),
  kdfOps: v.pipe(v.number(), v.integer(), v.minValue(1)),
  kdfMem: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const CryptoEnvelopesResponseSchema = v.object({
  envelopes: v.array(CryptoEnvelopeSchema),
});

export type CryptoEnvelope = v.InferOutput<typeof CryptoEnvelopeSchema>;

// --- 派生型（client の送信形はここから得る） ---
// chunk 書込み系の派生型は #44（RxDB 移行）で client から消えたため削除済み

export type ConvertRequest = v.InferInput<typeof ConvertSchema>;
export type SaveConversionRequest = v.InferInput<typeof SaveConversionSchema>;
