import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { blob, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { AAD } from "@zakki/core/crypto/aad.ts";

/**
 * 統合チャンクモデル（docs/CHUNKS.md, 2026-07-06 決定）。
 * sessions / entries を廃止し、chunk 単一の自己参照ツリーで記録を持つ。
 *
 * - `parent_id IS NULL` = 日付チャンク（トップレベル。`date` に YYYY-MM-DD、1 日 1 件）
 * - それ以外は親バッファの 1 行。`(parent_id, position)` を安定キーとして
 *   決定的チャンク化（chunkText）の結果を upsert する
 * - 子を持つチャンク（旧・名前付きセッション相当）も親バッファの position 空間を
 *   共有する: 親バッファの行削除はその行の子孫ごと cascade で消える（受容済み）
 * - `content` が本文の唯一の保持者（raw / converted は廃止）。E2E 暗号 ON では
 *   暗号化する（AAD ラベルは {@link AAD.chunkContent}）。ただし日付チャンクの content は date と
 *   同値の平文（date が平文である方針の帰結。復号もスキップする）
 */
export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** NULL = 日付チャンク（トップレベル）。自己参照で任意深さのツリーを成す */
    parentId: integer("parent_id").references((): AnySQLiteColumn => chunks.id, {
      onDelete: "cascade",
    }),
    /** 親バッファ内の出現順（0 始まり）。日付チャンクは 0 固定（順序は date が持つ） */
    position: integer("position").notNull(),
    content: text("content").notNull(),
    /** 日付チャンクのみ YYYY-MM-DD（平文）。それ以外は NULL */
    date: text("date"),
    /** ネガポジ極性 [-1,+1]（解析パスで算出・永続化）。未解析・日付チャンクは null */
    polarity: real("polarity"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    // 兄弟内の安定キー。SQLite の unique は NULL を別値扱いするため、
    // トップレベル（parent_id NULL）同士には効かない（一意性は date 側で担保）
    uniqueIndex("chunks_parent_position").on(t.parentId, t.position),
    // 日付チャンクは 1 日 1 件
    uniqueIndex("chunks_date_unique")
      .on(t.date)
      .where(sql`"date" IS NOT NULL`),
  ],
);

/**
 * チャンクへのユーザ明示タグ（旧 session_tags の一般化）。自動付与タグ
 * （{@link tags}）とは独立の名前空間で、解析パス（analyzeAll の全消し再挿入・
 * 孤立タグ削除）のライフサイクルに干渉しない。一意制約は tags と同じく
 * fingerprint（ブラインドインデックス）に置く。暗号 OFF は fingerprint = 平文名。
 */
export const chunkUserTags = sqliteTable(
  "chunk_user_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chunkId: integer("chunk_id")
      .notNull()
      .references(() => chunks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** ブラインドインデックス。暗号 OFF は平文名、ON は fingerprint(name) */
    nameFingerprint: text("name_fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("chunk_user_tags_unique").on(t.chunkId, t.nameFingerprint)],
);

/**
 * chunk ツリー移行（0010）が残した AAD 付替えの宿題（暗号 ON の DB のみ意味を持つ）。
 *
 * SQL マイグレーションは復号できないため、旧テーブルから移送した暗号文は
 * 旧 AAD（"session.name" / "sessionTag.name"）のまま格納されている。アンロック後に
 * {@link import("@zakki/data/crypto/init.ts").applyAadFixups} が新 AAD へ暗号化し直し、
 * 行を消す。暗号 OFF の DB では平文がそのまま正しいので、単に行を消すだけでよい。
 */
export const aadFixups = sqliteTable("aad_fixups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** 付替え先フィールド: {@link AAD.chunkContent}（旧 session.name） / {@link AAD.chunkUserTagName}（旧 sessionTag.name） */
  kind: text("kind", { enum: [AAD.chunkContent, AAD.chunkUserTagName] }).notNull(),
  /** 対象行の id（kind に応じて chunks.id / chunk_user_tags.id） */
  rowId: integer("row_id").notNull(),
});

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

/**
 * chunk 間の関連（docs/CONCEPT.md データモデル素案）。双方向とみなし from < to で正規化。
 * 任意階層のチャンク同士で張れる（docs/CHUNKS.md）。日付チャンク間の時系列リンクは
 * 保存せずグラフクエリで導出する。
 */
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

export type Chunk = typeof chunks.$inferSelect;
export type ChunkUserTag = typeof chunkUserTags.$inferSelect;
export type Correction = typeof corrections.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Link = typeof links.$inferSelect;
export type KeyEnvelope = typeof keyEnvelopes.$inferSelect;
export type EnvelopeKind = KeyEnvelope["kind"];
