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
import { API_BASE } from "@zakki/web/shared/api-base.ts";
import type { CryptoEnvelope } from "@zakki/web/shared/api-schemas.ts";
import { CryptoEnvelopesResponseSchema } from "@zakki/web/shared/api-schemas.ts";

/**
 * fetch 互換の最小型（テスト・Hono `app.request` を注入できるよう構造的に絞る。
 * bun の `typeof fetch` は preconnect 等の静的プロパティまで要求するため使わない）
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** サーバから封筒一覧を取得する（暗号未プロビジョンの DB では空配列） */
export async function fetchEnvelopes(fetchFn: FetchLike = fetch): Promise<CryptoEnvelope[]> {
  const res = await fetchFn(`${API_BASE}/crypto/envelopes`);
  if (!res.ok) {
    throw new Error(`crypto/envelopes: HTTP ${res.status}`);
  }
  return v.parse(CryptoEnvelopesResponseSchema, await res.json()).envelopes;
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
