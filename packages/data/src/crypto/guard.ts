import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import { keyEnvelopes } from "@zakki/data/db/schema.ts";

/**
 * 暗号化済み DB のサイレント平文読み書きを防ぐガード（issue #46）。
 *
 * CryptoContext は WeakMap で Db に紐付き、未登録なら暗号 OFF（平文）として
 * 扱われる（crypto-context.ts）。そのため、暗号 ON で初期化した DB を
 * アンロックせずに開くと、data 層の全関数が暗号文をそのまま平文として
 * 読み書きしてしまう（例外にならず、書き込みは平文混入の不整合になる）。
 *
 * 本関数はアンロック試行後・最初のデータアクセス前に呼び、
 * 1. `key_envelopes` に封筒がある（= この DB は暗号 ON で初期化済み）
 * 2. かつ {@link getCrypto} が undefined（= アンロックされていない）
 * の両方が成立したら平文フォールバックせず throw する。
 *
 * 暗号 OFF の DB（封筒なし）と、アンロック済みの DB では no-op。
 * 逆方向（暗号 OFF の DB を ZAKKI_ENCRYPTION=1 で開く）は unlockOrSetup が
 * 初期化を走らせる正常系なので、本ガードの対象外。
 */
export async function assertCryptoReady(db: Db): Promise<void> {
  if (getCrypto(db) !== undefined) return;
  const [envelope] = await db.select({ kind: keyEnvelopes.kind }).from(keyEnvelopes).limit(1);
  if (envelope !== undefined) {
    throw new Error(
      "この DB は E2E 暗号で初期化されています。アンロックせずに開くと暗号文を平文として読み書きしてしまうため中止します。ZAKKI_ENCRYPTION=1 を設定して起動してください",
    );
  }
}
