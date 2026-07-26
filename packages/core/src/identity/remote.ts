import type { Identity } from "@zakki/core/identity/types.ts";

/**
 * RemoteIdentity（docs/RESEARCH.md §6 設計決定 3, issue #105）。
 *
 * コントロールプレーン（apps/api）へパスキーでログインして得た「自分の DB の所在と
 * 短命トークン」を {@link Identity} の形へ写すだけの純関数。DB / 暗号 / sync 層は
 * Identity しか見ないので、この 1 ファイルを足すだけでリモート構成に切り替わる
 * （＝ LocalIdentity 経路は無改修）。
 *
 * ここに **鍵材料は現れない**: `token` は「そのユーザの Turso DB を開ける権限」であって
 * 復号鍵ではない。DEK は封筒としてユーザ自身の DB の中にあり、コントロールプレーンも
 * 中継サーバも復号できない（E2E）。`Identity.encKey` はこの経路では設定しない。
 */

/** `GET /me/db`（apps/api）の応答 + どのアカウントのものか。トークンはログに出さない */
export interface RemoteDbConnection {
  /** コントロールプレーンのアカウント ID（セッション発行時に判る） */
  readonly accountId: string;
  /** ユーザごと Turso DB の URL（例 libsql://zakki-<account>-<org>.turso.io） */
  readonly dbUrl: string;
  /** DB スコープの短命トークン。秘密 */
  readonly token: string;
  /** token の失効時刻（epoch 秒）。先回りの取り直しに使う */
  readonly expiresAt: number;
}

/**
 * 取得済みの接続情報を Identity へ写す。userId はコントロールプレーンの
 * accountId（DB-per-user の鍵）で、ジャーナル DB 側には user 概念を持ち込まない。
 */
export function remoteIdentity(connection: RemoteDbConnection): Identity {
  return {
    userId: connection.accountId,
    tursoUrl: connection.dbUrl,
    tursoToken: connection.token,
  };
}

/** 失効の先回り判定に使う既定の余裕（秒）。TTL 内でも残りがこれ未満なら取り直す */
const DEFAULT_SKEW_SEC = 60;

/**
 * 接続情報が失効済み、または残り {@link DEFAULT_SKEW_SEC} 秒未満か。
 * 時刻は呼び出し側が渡す（core はランタイム非依存＝時計を持たない）。
 */
export function isConnectionExpiring(
  connection: RemoteDbConnection,
  nowSec: number,
  skewSec: number = DEFAULT_SKEW_SEC,
): boolean {
  return connection.expiresAt - skewSec <= nowSec;
}
