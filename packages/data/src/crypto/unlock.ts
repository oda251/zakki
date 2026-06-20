import { generateDek } from "@zakki/core/crypto/dek.ts";
import { ready } from "@zakki/core/crypto/sodium.ts";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import {
  addKeyfileEnvelope,
  addPassphraseEnvelope,
  addRecoveryEnvelope,
  generateRecoveryCode,
  listEnvelopeKinds,
  unlockWithKeyfile,
  unlockWithPassphrase,
} from "@zakki/data/crypto/envelopes.ts";
import { migratePlaintextToEncrypted, provisionCrypto } from "@zakki/data/crypto/init.ts";

/**
 * 起動時のアンロック／初回セットアップを束ねるオーケストレータ（Phase 6）。
 *
 * stdin に依存しないよう、UI（パスフレーズ入力・リカバリコード表示）は注入された
 * 非同期コールバックで行う。これにより data 層だけで決定的にテストできる。
 */
export interface UnlockPrompts {
  /** 初回: 新パスフレーズを取得（確認ループは呼び出し側で処理済みの前提） */
  newPassphrase(): Promise<string>;
  /** 再起動時: パスフレーズを 1 回尋ねる（失敗時の再試行は呼び出し側） */
  passphrase(): Promise<string>;
  /** リカバリコードを 1 回だけ表示し、保存の確認（ack）を待つ */
  showRecoveryCode(code: string): Promise<void>;
}

/**
 * 暗号をアンロック、または初回セットアップして {@link CryptoContext} を返す。
 *
 * 契約:
 * - **初回（封筒が 1 つも無い）**: DEK を新規生成し、キーファイル封筒（このデバイスを
 *   信頼）・パスフレーズ封筒（`prompts.newPassphrase()`）・リカバリ封筒
 *   （`generateRecoveryCode()` を `prompts.showRecoveryCode()` で 1 回表示）を作る。
 *   既存平文があれば {@link migratePlaintextToEncrypted} でその場暗号化し、provision する。
 * - **再起動（封筒あり）**: まずキーファイル封筒で **無言アンロック** を試みる。成功すれば
 *   provision して返す。キーファイル封筒が無い／失敗した場合は `prompts.passphrase()` を
 *   1 回呼んでパスフレーズでアンロックする。**パスフレーズ違いはそのまま例外を投げる**
 *   ので、再試行は呼び出し側（CLI/TUI）でループする責務とする。
 *
 * 秘密はログに出さない（リカバリコードの 1 回表示のみ例外）。
 *
 * @param keyfileKek キーファイル由来の KEK（このデバイスの信頼鍵）
 */
export async function unlockOrSetup(
  db: Db,
  keyfileKek: Uint8Array,
  prompts: UnlockPrompts,
): Promise<CryptoContext> {
  await ready();
  const kinds = await listEnvelopeKinds(db);

  if (kinds.length === 0) {
    const dek = generateDek();
    // このデバイスを信頼（キーファイル封筒）。以後は無言で開ける。
    await addKeyfileEnvelope(db, dek, keyfileKek);
    // パスフレーズ封筒（別デバイス・キーファイル紛失時のアンロック手段）。
    const passphrase = await prompts.newPassphrase();
    await addPassphraseEnvelope(db, dek, passphrase);
    // リカバリ封筒（パスフレーズも失った場合の最後の手段）。1 回だけ表示。
    const code = generateRecoveryCode();
    await addRecoveryEnvelope(db, dek, code);
    await prompts.showRecoveryCode(code);

    const ctx = provisionCrypto(db, dek);
    // 暗号 OFF で書かれた既存平文があればその場で暗号化（新規 DB では no-op）。
    await migratePlaintextToEncrypted(db, ctx);
    return ctx;
  }

  // 再起動: キーファイルがあれば無言アンロックを最優先で試す。
  if (kinds.includes("keyfile")) {
    try {
      const dek = await unlockWithKeyfile(db, keyfileKek);
      return provisionCrypto(db, dek);
    } catch {
      // キーファイル KEK が一致しない（別デバイスへ DB だけ持ち込んだ等）。
      // パスフレーズへフォールバックする。
    }
  }

  // パスフレーズでアンロック。違えば unlockWithPassphrase が throw する（呼び出し側で再試行）。
  const passphrase = await prompts.passphrase();
  const dek = await unlockWithPassphrase(db, passphrase);
  return provisionCrypto(db, dek);
}
