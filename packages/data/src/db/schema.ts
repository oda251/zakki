import { sql } from "drizzle-orm";
import { blob, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 記録の入れ物（スペース）。デフォルトセッション（name = NULL）は日付ベース管理
 * （1 日 1 件、TUI が使う従来挙動）で、名前付きセッションは同日に複数持てる。
 *
 * E2E 暗号（ZAKKI_ENCRYPTION）では `name` を暗号化する（AAD "session.name"）。
 * ただし NULL は NULL のまま格納する — デフォルトセッション判定
 * （`name IS NULL`）を SQL で行うため。「名前付きか否か」がメタデータとして
 * 見える点は `date` が平文である現行方針と同水準として受容する。
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** NULL = デフォルトセッション（日付ベース）。名前付きは暗号 ON で暗号文 */
    name: text("name"),
    /** ローカル日付 YYYY-MM-DD（平文。entries.date と同方針） */
    date: text("date").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // デフォルトセッションは 1 日 1 件（名前付きには効かない部分 unique）
    uniqueIndex("sessions_default_date")
      .on(t.date)
      .where(sql`"name" IS NULL`),
  ],
);

/**
 * セッションへのユーザ明示タグ。自動付与タグ（{@link tags}）とは独立の
 * 名前空間で、解析パス（analyzeAll の全消し再挿入・孤立タグ削除）の
 * ライフサイクルに干渉しない。一意制約は tags と同じく fingerprint
 * （ブラインドインデックス）に置く。暗号 OFF は fingerprint = 平文名。
 */
export const sessionTags = sqliteTable(
  "session_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** ブラインドインデックス。暗号 OFF は平文名、ON は fingerprint(name) */
    nameFingerprint: text("name_fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("session_tags_unique").on(t.sessionId, t.nameFingerprint)],
);

/**
 * 1 セッションの生入力ログ（docs/CONCEPT.md データモデル素案）。
 * raw（ローマ字/かな）と converted を分離して保持する。変換・チャンク化は
 * 非可逆な自動処理であり、再処理（エンジン差し替え時の再変換）に原文が必要。
 *
 * entry ↔ session は 1:1（unique index）。`date` はセッションの日付の複製で、
 * 日付 join（listChunksWithDate / dailySentiment / digest）を無変更で保つために残す。
 */
export const entries = sqliteTable(
  "entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** ローカル日付 YYYY-MM-DD（sessions.date と同値） */
    date: text("date").notNull(),
    raw: text("raw").notNull().default(""),
    converted: text("converted").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("entries_session_unique").on(t.sessionId)],
);

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
    /** タイトルは content からの純粋な派生（makeTitle）なので保持しない */
    content: text("content").notNull(),
    /** ネガポジ極性 [-1,+1]（解析パスで算出・永続化）。未解析は null */
    polarity: real("polarity"),
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

/**
 * かなセグメント → 確定変換 のキャッシュ（docs/CONCEPT.md §1 への追補）。
 * エンジンの自動変換結果を永続化し、起動時に ConversionPipeline へ流し込む。
 * これにより毎起動の全文再変換を避ける。corrections（手動修正）が優先される。
 */
export const conversionCache = sqliteTable("conversion_cache", {
  kana: text("kana").primaryKey(),
  converted: text("converted").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * 自動付与されるタグ（docs/CONCEPT.md §3）。
 *
 * E2E 暗号（Phase 5b）対応のため、一意制約は平文 `name` ではなく
 * `name_fingerprint`（ブラインドインデックス）に置く。暗号 OFF では
 * fingerprint = 平文名（重複排除の挙動は従来どおり）。暗号 ON では
 * `name` = 暗号文 base64、`name_fingerprint` = 鍵付きハッシュ。
 */
export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** ブラインドインデックス。暗号 OFF は平文名、ON は fingerprint(name) */
    nameFingerprint: text("name_fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("tags_name_fingerprint_unique").on(t.nameFingerprint)],
);

/**
 * E2E 暗号のメタデータ（Phase 5b）。単一行（id=1）で、バージョンと作成時刻を保持する。
 *
 * Phase 6 で封筒（wrapped DEK）の正本は {@link keyEnvelopes} へ移った。`wrapped_dek` 列は
 * 後方互換のため残すが（Phase 5 DB が読めるよう・マイグレーションの移送元）、もはや
 * 真実の源ではない。アンロックは必ず `key_envelopes` を参照する。
 */
export const cryptoMeta = sqliteTable("crypto_meta", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
  wrappedDek: blob("wrapped_dek", { mode: "buffer" }).notNull(),
  kekSalt: blob("kek_salt", { mode: "buffer" }),
  createdAt: text("created_at").notNull(),
});

/**
 * DEK を開くための封筒（Phase 6）。同一の DEK に対して複数のアンロック手段を持つ。
 *
 * 各行は 1 つの KEK で wrap した独立した封筒で、`kind` で手段を区別する：
 * - `keyfile`: キーファイル KEK（このデバイスを信頼する）。`kdf_*` は null。
 * - `passphrase`: パスフレーズから Argon2id 導出した KEK。`kdf_salt/ops/mem` を保存。
 * - `recovery`: リカバリコードから Argon2id 導出した KEK。同上。
 *
 * `kdf_ops/kdf_mem` は導出時の Argon2id パラメータ。将来パラメータを引き上げても、
 * 既存封筒は保存値で再導出して開けるように、封筒ごとに保存する。
 *
 * パスフレーズ変更は `passphrase` 行の再 wrap（新ソルト）だけで完結し、データ行の
 * 再暗号化は一切しない（DEK は不変）。
 */
export const keyEnvelopes = sqliteTable("key_envelopes", {
  kind: text("kind", { enum: ["keyfile", "passphrase", "recovery"] }).primaryKey(),
  /** KEK で AEAD した DEK 封筒（`nonce || ciphertext`） */
  wrappedDek: blob("wrapped_dek", { mode: "buffer" }).notNull(),
  /** Argon2id ソルト（keyfile は null） */
  kdfSalt: blob("kdf_salt", { mode: "buffer" }),
  /** Argon2id opsLimit（keyfile は null） */
  kdfOps: integer("kdf_ops"),
  /** Argon2id memLimit（バイト, keyfile は null） */
  kdfMem: integer("kdf_mem"),
  createdAt: text("created_at").notNull(),
});

export const chunkTags = sqliteTable(
  "chunk_tags",
  {
    chunkId: integer("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    /** TF-IDF スコア（付与根拠の記録） */
    score: real("score").notNull(),
  },
  (t) => [uniqueIndex("chunk_tags_pair").on(t.chunkId, t.tagId)],
);

/** chunk 間の関連（docs/CONCEPT.md データモデル素案）。双方向とみなし from < to で正規化 */
export const links = sqliteTable(
  "links",
  {
    fromChunkId: integer("from_chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    toChunkId: integer("to_chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    origin: text("origin", { enum: ["auto", "manual"] }).notNull(),
  },
  (t) => [uniqueIndex("links_pair").on(t.fromChunkId, t.toChunkId)],
);

/**
 * chunk の埋め込みベクトル（docs/CONCEPT.md データモデル素案）。
 * Float32Array を BLOB で保持し、近傍探索は総当たりコサイン
 * （数万件規模で十分。`RESEARCH.md` §2 の代替案を採用し sqlite-vec は不使用）。
 */
export const embeddings = sqliteTable("embeddings", {
  chunkId: integer("chunk_id")
    .primaryKey()
    .references(() => chunks.id, { onDelete: "cascade" }),
  /** content のハッシュ。変化検知して再計算する */
  contentHash: text("content_hash").notNull(),
  model: text("model").notNull(),
  vector: blob("vector", { mode: "buffer" }).notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type Session = typeof sessions.$inferSelect;
export type SessionTag = typeof sessionTags.$inferSelect;
export type Entry = typeof entries.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type Correction = typeof corrections.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Link = typeof links.$inferSelect;
export type KeyEnvelope = typeof keyEnvelopes.$inferSelect;
export type EnvelopeKind = KeyEnvelope["kind"];
