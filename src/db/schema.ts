import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 1 セッション（日付単位）の生入力ログ（docs/CONCEPT.md データモデル素案）。
 * raw（ローマ字/かな）と converted を分離して保持する。変換・チャンク化は
 * 非可逆な自動処理であり、再処理（エンジン差し替え時の再変換）に原文が必要。
 */
export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** ローカル日付 YYYY-MM-DD */
  date: text("date").notNull().unique(),
  raw: text("raw").notNull().default(""),
  converted: text("converted").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * 自動分割された意味単位。決定的チャンク化により entry のテキストから
 * 再生成されるため、(entry_id, position) を安定キーとして upsert する。
 */
export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    /** entry 内での出現順（0 始まり） */
    position: integer("position").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("chunks_entry_position").on(t.entryId, t.position)],
);

/**
 * 手動修正（候補ローテーション）の学習記録（docs/FEATURES.md §ユーザー辞書の自動学習）。
 * かな（変換単位）の完全一致で、以後の変換時に最優先候補として使う。
 */
export const corrections = sqliteTable("corrections", {
  kana: text("kana").primaryKey(),
  chosen: text("chosen").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Entry = typeof entries.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type Correction = typeof corrections.$inferSelect;
