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
// chunk 書込み系（#44 RxDB 移行）・変換系（#26 wasm 移設）の派生型は撤去済み。
