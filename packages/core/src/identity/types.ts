/**
 * 利用者の同一性とクラウド接続情報を表す、ランタイム非依存の抽象（docs/RESEARCH.md §6）。
 * core はランタイム非依存のため、ここでは node/bun 等に依存せず純粋な型のみを定義する。
 * 実体の解決（env・設定ファイル読込）は data 層の resolver が担う。
 */
export interface Identity {
  /** 論理ユーザ ID。未設定時はローカル専用の "local"。DB-per-user の鍵になる */
  readonly userId: string;
  /** リモートプライマリ（例: libsql://...turso.io）。未設定ならローカル専用 */
  readonly tursoUrl?: string;
  /** スコープ付き認証トークン。ログ等に出してはならない */
  readonly tursoToken?: string;
  /** E2E 暗号鍵（Phase 5 で使用）。現時点では未使用 */
  readonly encKey?: Uint8Array;
}
