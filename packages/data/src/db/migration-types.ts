/**
 * 埋め込み migration の形（issue #134）。drizzle の `MigrationMeta` と同じ意味を持つ。
 * 生成物（migrations.generated.ts）と適用側（connect-web.ts）の共有点。
 */
export interface EmbeddedMigration {
  /** 生成物の可読性のための識別子（drizzle の journal の tag） */
  readonly tag: string;
  /** journal の `when`。適用済み判定に使う（drizzle と同じ基準） */
  readonly folderMillis: number;
  /** SQL ファイル全体の SHA-256（16 進）。`__drizzle_migrations.hash` に入る値 */
  readonly hash: string;
  /** `--> statement-breakpoint` で分割した文 */
  readonly sql: readonly string[];
}
