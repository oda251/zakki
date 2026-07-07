/**
 * クライアント側アンロック（issue #43, 暫定。恒久は #7 passkey-PRF）。
 *
 * サーバから封筒（wrapped DEK。KEK 無しには開けない公開可能情報）を取得し、
 * パスフレーズ → Argon2id → KEK → unwrapDek を **すべてクライアントで** 行う。
 * サーバへパスフレーズ・DEK を送らず、得た DEK はメモリのみで保持する
 * （localStorage / sessionStorage / IndexedDB へは書かない）。
 *
 * 事前に {@link import("@zakki/core/crypto/sodium.ts").ready} 完了が前提（呼び出し側の責務）。
 */
import * as v from "valibot";
import { unwrapDek } from "@zakki/core/crypto/dek.ts";
import { deriveKey } from "@zakki/core/crypto/kdf.ts";
import { sodium } from "@zakki/core/crypto/sodium.ts";
import type { FetchLike } from "@zakki/web/client/api/client.ts";
import { request } from "@zakki/web/client/api/client.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";
import { CryptoEnvelopesResponseSchema } from "@zakki/web/shared/api-schemas.ts";

/** サーバから封筒一覧を取得する（暗号未プロビジョンの DB では空配列） */
export async function fetchEnvelopes(fetchFn?: FetchLike): Promise<CryptoEnvelope[]> {
  const raw = await request<unknown>("/crypto/envelopes", undefined, fetchFn);
  return v.parse(CryptoEnvelopesResponseSchema, raw).envelopes;
}

/**
 * 封筒を secret（パスフレーズ／リカバリコード）で開いて DEK を返す。
 * secret 違い・改竄は `unwrapDek`（AEAD 認証）が例外を投げる。
 */
export function openEnvelope(envelope: CryptoEnvelope, secret: string): Uint8Array {
  const salt = sodium.from_base64(envelope.kdfSalt, sodium.base64_variants.ORIGINAL);
  const kek = deriveKey(secret, salt, envelope.kdfOps, envelope.kdfMem);
  return unwrapDek(sodium.from_base64(envelope.wrappedDek, sodium.base64_variants.ORIGINAL), kek);
}

const MAX_ATTEMPTS = 3;

/**
 * passphrase 封筒を prompt で得た入力で開く。最大 {@link MAX_ATTEMPTS} 回まで再試行し、
 * 封筒が無い／キャンセル（prompt が null）／全試行失敗なら null を返す。
 * 秘密（パスフレーズ・DEK）はログに出さない。
 */
export async function unlockWithPrompt(
  envelopes: readonly CryptoEnvelope[],
  promptFn: (attempt: number) => Promise<string | null>,
): Promise<Uint8Array | null> {
  const envelope = envelopes.find((e) => e.kind === "passphrase");
  if (envelope === undefined) return null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const secret = await promptFn(attempt);
    if (secret === null) return null;
    try {
      return openEnvelope(envelope, secret);
    } catch {
      // パスフレーズ違い（AEAD 認証失敗）。再試行する。
    }
  }
  return null;
}
