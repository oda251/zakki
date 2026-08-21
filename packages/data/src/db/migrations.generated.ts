// このファイルは自動生成です。編集しないでください。
// 生成: bun run gen-migrations（packages/data/tools/gen-migrations.ts）
import type { EmbeddedMigration } from "@zakki/data/db/migration-types.ts";

/**
 * packages/data/drizzle を埋め込んだもの（issue #134）。Workers ランタイムは
 * node:fs で migration を読めないため、ソースに載せて配布する。
 */
export const EMBEDDED_MIGRATIONS: readonly EmbeddedMigration[] = [
  {
    "tag": "0000_init",
    "folderMillis": 1781275259659,
    "hash": "16ebe14b2083d2c5e8dccf987e6432baf6904b86b7992bbc11ea084414f79508",
    "sql": [
      "CREATE TABLE `chunks` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`entry_id` integer NOT NULL,\n\t`position` integer NOT NULL,\n\t`title` text NOT NULL,\n\t`content` text NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL,\n\tFOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade\n);\n",
      "\nCREATE UNIQUE INDEX `chunks_entry_position` ON `chunks` (`entry_id`,`position`);",
      "\nCREATE TABLE `entries` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`date` text NOT NULL,\n\t`raw` text DEFAULT '' NOT NULL,\n\t`converted` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);\n",
      "\nCREATE UNIQUE INDEX `entries_date_unique` ON `entries` (`date`);"
    ]
  },
  {
    "tag": "0001_corrections",
    "folderMillis": 1781282282928,
    "hash": "b814ac891590302fed9ee2e2f45c71c6921f43b4c13b8d9e4f8a2ec80c771d80",
    "sql": [
      "CREATE TABLE `corrections` (\n\t`kana` text PRIMARY KEY NOT NULL,\n\t`chosen` text NOT NULL,\n\t`updated_at` text NOT NULL\n);\n"
    ]
  },
  {
    "tag": "0002_tags-links",
    "folderMillis": 1781283040303,
    "hash": "f476489fb90b372d8c37313d3a8197b21364b0b6441770d73db5c3c741116aba",
    "sql": [
      "CREATE TABLE `chunk_tags` (\n\t`chunk_id` integer NOT NULL,\n\t`tag_id` integer NOT NULL,\n\t`score` real NOT NULL,\n\tFOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade\n);\n",
      "\nCREATE UNIQUE INDEX `chunk_tags_pair` ON `chunk_tags` (`chunk_id`,`tag_id`);",
      "\nCREATE TABLE `links` (\n\t`from_chunk_id` integer NOT NULL,\n\t`to_chunk_id` integer NOT NULL,\n\t`score` real NOT NULL,\n\t`origin` text NOT NULL,\n\tFOREIGN KEY (`from_chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade,\n\tFOREIGN KEY (`to_chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade\n);\n",
      "\nCREATE UNIQUE INDEX `links_pair` ON `links` (`from_chunk_id`,`to_chunk_id`);",
      "\nCREATE TABLE `tags` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`name` text NOT NULL,\n\t`created_at` text NOT NULL\n);\n",
      "\nCREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);"
    ]
  },
  {
    "tag": "0003_embeddings",
    "folderMillis": 1781284114114,
    "hash": "87af8659fe1324a8e21f08b1957bd4b56ffadd60caa1f4813fbfdba62b570ede",
    "sql": [
      "CREATE TABLE `embeddings` (\n\t`chunk_id` integer PRIMARY KEY NOT NULL,\n\t`content_hash` text NOT NULL,\n\t`model` text NOT NULL,\n\t`vector` blob NOT NULL,\n\t`updated_at` text NOT NULL,\n\tFOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade\n);\n"
    ]
  },
  {
    "tag": "0004_conversion_cache",
    "folderMillis": 1781341192155,
    "hash": "289b45d60fc9b607ca3347ebeac8f376842cf1c22cc04986e17faa652dbbb891",
    "sql": [
      "CREATE TABLE `conversion_cache` (\n\t`kana` text PRIMARY KEY NOT NULL,\n\t`converted` text NOT NULL,\n\t`updated_at` text NOT NULL\n);\n"
    ]
  },
  {
    "tag": "0005_chunk_polarity",
    "folderMillis": 1781365286206,
    "hash": "b0c19fe97e645d7e2ae381dce059bda4b1367b2fd122f180a0a2a5612733ba1b",
    "sql": [
      "ALTER TABLE `chunks` ADD `polarity` real;"
    ]
  },
  {
    "tag": "0006_drop_chunk_title",
    "folderMillis": 1781371185032,
    "hash": "2d1453e2696ea92f3142df0a4da25a255f333696f8e0d6165323ea95825e3587",
    "sql": [
      "ALTER TABLE `chunks` DROP COLUMN `title`;"
    ]
  },
  {
    "tag": "0007_cynical_power_man",
    "folderMillis": 1781979857565,
    "hash": "dd6888031f77dd884525d480fea6a3252e9f139915861cdde29678627a01efe9",
    "sql": [
      "CREATE TABLE `crypto_meta` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`version` integer NOT NULL,\n\t`wrapped_dek` blob NOT NULL,\n\t`kek_salt` blob,\n\t`created_at` text NOT NULL\n);\n",
      "\nDROP INDEX `tags_name_unique`;",
      "\nALTER TABLE `tags` ADD `name_fingerprint` text NOT NULL DEFAULT '';",
      "\nUPDATE `tags` SET `name_fingerprint` = `name` WHERE `name_fingerprint` = '';",
      "\nCREATE UNIQUE INDEX `tags_name_fingerprint_unique` ON `tags` (`name_fingerprint`);\n"
    ]
  },
  {
    "tag": "0008_strange_hannibal_king",
    "folderMillis": 1781980931748,
    "hash": "cac16742c9aa94602c45317c3b5bb624c6ed685744c79dc97d01ea122efcbfd2",
    "sql": [
      "CREATE TABLE `key_envelopes` (\n\t`kind` text PRIMARY KEY NOT NULL,\n\t`wrapped_dek` blob NOT NULL,\n\t`kdf_salt` blob,\n\t`kdf_ops` integer,\n\t`kdf_mem` integer,\n\t`created_at` text NOT NULL\n);\n",
      "\nINSERT OR IGNORE INTO `key_envelopes` (`kind`, `wrapped_dek`, `kdf_salt`, `kdf_ops`, `kdf_mem`, `created_at`)\nSELECT 'keyfile', `wrapped_dek`, NULL, NULL, NULL, `created_at` FROM `crypto_meta` WHERE `id` = 1;\n"
    ]
  },
  {
    "tag": "0009_sessions",
    "folderMillis": 1783182391764,
    "hash": "7a5fc3a09e2b95ebde2cdad7b819082514d3d337f71a344e801c164c23ad45f4",
    "sql": [
      "CREATE TABLE `sessions` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`name` text,\n\t`date` text NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL\n);\n",
      "\nCREATE UNIQUE INDEX `sessions_default_date` ON `sessions` (`date`) WHERE \"name\" IS NULL;",
      "\nCREATE TABLE `session_tags` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`session_id` integer NOT NULL,\n\t`name` text NOT NULL,\n\t`name_fingerprint` text NOT NULL,\n\t`created_at` text NOT NULL,\n\tFOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade\n);\n",
      "\nCREATE UNIQUE INDEX `session_tags_unique` ON `session_tags` (`session_id`,`name_fingerprint`);",
      "\nINSERT INTO `sessions` (`name`, `date`, `created_at`, `updated_at`)\nSELECT NULL, `date`, `created_at`, `updated_at` FROM `entries`;",
      "\nCREATE TABLE `__new_entries` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`session_id` integer NOT NULL,\n\t`date` text NOT NULL,\n\t`raw` text DEFAULT '' NOT NULL,\n\t`converted` text DEFAULT '' NOT NULL,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL,\n\tFOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade\n);\n",
      "\nINSERT INTO `__new_entries` (`id`, `session_id`, `date`, `raw`, `converted`, `created_at`, `updated_at`)\nSELECT e.`id`, s.`id`, e.`date`, e.`raw`, e.`converted`, e.`created_at`, e.`updated_at`\nFROM `entries` e JOIN `sessions` s ON s.`date` = e.`date` AND s.`name` IS NULL;",
      "\nDROP TABLE `entries`;",
      "\nALTER TABLE `__new_entries` RENAME TO `entries`;",
      "\nCREATE UNIQUE INDEX `entries_session_unique` ON `entries` (`session_id`);\n"
    ]
  },
  {
    "tag": "0010_chunk_tree",
    "folderMillis": 1783432800000,
    "hash": "d519688c89645a798e6fc98b583feb2498b40a044eba7b3a782c07b52293673d",
    "sql": [
      "-- 統合チャンクモデルへの移行（docs/CHUNKS.md, 2026-07-06）。\n-- sessions / entries を廃止し、chunks を自己参照ツリーへ再構築する。\n-- libsql の migrate バッチは FK 無効で実行されるため、テーブル再構築\n-- （create → copy → drop → rename）が安全に行える。chunk id は保存する\n-- （links / chunk_tags / embeddings は無変更で整合する）。\n-- mig_session_id / mig_container は移行中だけの作業列で、最後に DROP する。\nCREATE TABLE `chunks_new` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`parent_id` integer,\n\t`position` integer NOT NULL,\n\t`content` text NOT NULL,\n\t`date` text,\n\t`polarity` real,\n\t`created_at` text NOT NULL,\n\t`updated_at` text NOT NULL,\n\t`mig_session_id` integer,\n\t`mig_container` integer NOT NULL DEFAULT 0,\n\tFOREIGN KEY (`parent_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade\n);\n",
      "\n-- 1. 既存の本文チャンクを id 保存で移送（親は後段で配線）\nINSERT INTO `chunks_new` (`id`, `parent_id`, `position`, `content`, `date`, `polarity`, `created_at`, `updated_at`, `mig_session_id`, `mig_container`)\nSELECT c.`id`, NULL, c.`position`, c.`content`, NULL, c.`polarity`, c.`created_at`, c.`updated_at`, e.`session_id`, 0\nFROM `chunks` c JOIN `entries` e ON c.`entry_id` = e.`id`;\n",
      "\n-- 2. 日付チャンク（トップレベル・1 日 1 件）。content は date と同値の平文\nINSERT INTO `chunks_new` (`parent_id`, `position`, `content`, `date`, `polarity`, `created_at`, `updated_at`, `mig_session_id`, `mig_container`)\nSELECT NULL, 0, s.`date`, s.`date`, NULL, MIN(s.`created_at`), MIN(s.`created_at`), NULL, 0\nFROM `sessions` s GROUP BY s.`date`;\n",
      "\n-- 3. 旧・名前付きセッション → コンテナチャンク（content = name）。\n--    position は同日のデフォルトセッション本文チャンク数の直後に連番で置き、\n--    日付バッファの position 空間（0..n-1 が本文行）と衝突させない\nINSERT INTO `chunks_new` (`parent_id`, `position`, `content`, `date`, `polarity`, `created_at`, `updated_at`, `mig_session_id`, `mig_container`)\nSELECT NULL,\n\t(SELECT COUNT(*) FROM `chunks` c JOIN `entries` e ON c.`entry_id` = e.`id` JOIN `sessions` ds ON e.`session_id` = ds.`id`\n\t\tWHERE ds.`date` = s.`date` AND ds.`name` IS NULL)\n\t+ (SELECT COUNT(*) FROM `sessions` s2 WHERE s2.`date` = s.`date` AND s2.`name` IS NOT NULL AND s2.`id` < s.`id`),\n\ts.`name`, NULL, NULL, s.`created_at`, s.`updated_at`, s.`id`, 1\nFROM `sessions` s WHERE s.`name` IS NOT NULL;\n",
      "\n-- 4a. デフォルトセッションの本文チャンク → 日付チャンクの子\nUPDATE `chunks_new` SET `parent_id` = (\n\tSELECT dc.`id` FROM `chunks_new` dc\n\tWHERE dc.`date` = (SELECT s.`date` FROM `sessions` s WHERE s.`id` = `chunks_new`.`mig_session_id`)\n) WHERE `mig_container` = 0 AND `mig_session_id` IN (SELECT `id` FROM `sessions` WHERE `name` IS NULL);\n",
      "\n-- 4b. 名前付きセッションの本文チャンク → コンテナの子\nUPDATE `chunks_new` SET `parent_id` = (\n\tSELECT cc.`id` FROM `chunks_new` cc\n\tWHERE cc.`mig_container` = 1 AND cc.`mig_session_id` = `chunks_new`.`mig_session_id`\n) WHERE `mig_container` = 0 AND `mig_session_id` IN (SELECT `id` FROM `sessions` WHERE `name` IS NOT NULL);\n",
      "\n-- 4c. コンテナ → 日付チャンクの子\nUPDATE `chunks_new` SET `parent_id` = (\n\tSELECT dc.`id` FROM `chunks_new` dc\n\tWHERE dc.`date` = (SELECT s.`date` FROM `sessions` s WHERE s.`id` = `chunks_new`.`mig_session_id`)\n) WHERE `mig_container` = 1;\n",
      "\nCREATE TABLE `chunk_user_tags` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`chunk_id` integer NOT NULL,\n\t`name` text NOT NULL,\n\t`name_fingerprint` text NOT NULL,\n\t`created_at` text NOT NULL,\n\tFOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade\n);\n",
      "\n-- 5. セッションタグ → 対応チャンク（名前付き=コンテナ / デフォルト=日付チャンク）のユーザタグ\nINSERT INTO `chunk_user_tags` (`chunk_id`, `name`, `name_fingerprint`, `created_at`)\nSELECT COALESCE(\n\t(SELECT cc.`id` FROM `chunks_new` cc WHERE cc.`mig_container` = 1 AND cc.`mig_session_id` = st.`session_id`),\n\t(SELECT dc.`id` FROM `chunks_new` dc WHERE dc.`date` = (SELECT s.`date` FROM `sessions` s WHERE s.`id` = st.`session_id`))\n), st.`name`, st.`name_fingerprint`, st.`created_at`\nFROM `session_tags` st;\n",
      "\nCREATE TABLE `aad_fixups` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`kind` text NOT NULL,\n\t`row_id` integer NOT NULL\n);\n",
      "\n-- 6. 暗号 ON の DB 用: 旧 AAD のまま移送した暗号文の付替え予約\n--    （コンテナ content は旧 \"session.name\"、ユーザタグ name は旧 \"sessionTag.name\"）。\n--    暗号 OFF の DB では平文のまま正しく、アンロック時に行が消えるだけ\nINSERT INTO `aad_fixups` (`kind`, `row_id`) SELECT 'chunk.content', `id` FROM `chunks_new` WHERE `mig_container` = 1;\n",
      "\nINSERT INTO `aad_fixups` (`kind`, `row_id`) SELECT 'chunkUserTag.name', `id` FROM `chunk_user_tags`;\n",
      "\nALTER TABLE `chunks_new` DROP COLUMN `mig_session_id`;\n",
      "\nALTER TABLE `chunks_new` DROP COLUMN `mig_container`;\n",
      "\nDROP TABLE `chunks`;\n",
      "\nDROP TABLE `entries`;\n",
      "\nDROP TABLE `session_tags`;\n",
      "\nDROP TABLE `sessions`;\n",
      "\nALTER TABLE `chunks_new` RENAME TO `chunks`;\n",
      "\nCREATE UNIQUE INDEX `chunks_parent_position` ON `chunks` (`parent_id`,`position`);\n",
      "\nCREATE UNIQUE INDEX `chunks_date_unique` ON `chunks` (`date`) WHERE \"date\" IS NOT NULL;\n",
      "\nCREATE UNIQUE INDEX `chunk_user_tags_unique` ON `chunk_user_tags` (`chunk_id`,`name_fingerprint`);\n"
    ]
  },
  {
    "tag": "0011_repl_docs",
    "folderMillis": 1783440000000,
    "hash": "5e030553d310d3fe31ccfa9b62e19ddfa0fc7106a5fc086d03faffa201486243",
    "sql": [
      "CREATE TABLE `repl_docs` (\n\t`collection` text NOT NULL,\n\t`id` text NOT NULL,\n\t`updated_at` text NOT NULL,\n\t`deleted` integer NOT NULL,\n\t`data` text NOT NULL,\n\tPRIMARY KEY(`collection`, `id`)\n);\n",
      "\nCREATE INDEX `repl_docs_collection_updated` ON `repl_docs` (`collection`,`updated_at`,`id`);"
    ]
  },
  {
    "tag": "0012_passkey_envelope",
    "folderMillis": 1784997666583,
    "hash": "fc980b25a02deeb77dad0d70935637d5fedbb243e7c83bc89c0b796ae8ff74e5",
    "sql": [
      "ALTER TABLE `key_envelopes` ADD `credential_id` text;"
    ]
  },
  {
    "tag": "0013_multi_passkey_envelopes",
    "folderMillis": 1785101242767,
    "hash": "889fc6e3e25beb7619d527edc505c26245905d8ba9fa59be2a7bb1c032efe167",
    "sql": [
      "-- issue #120: key_envelopes の主キーを kind から代理キー(id)へ。単数 kind と\n-- 「passkey は credential ごと」を部分ユニークインデックスで表す。\n-- drizzle-kit 生成のテーブル再構築に 1 箇所だけ手を入れている: 新設の id は旧表に\n-- 存在しないので INSERT ... SELECT の列一覧から外し、AUTOINCREMENT に採番させる\n-- （既存行はそのまま移送される。生成のままだと \"no such column: id\" で落ちる）。\nPRAGMA foreign_keys=OFF;",
      "\nCREATE TABLE `__new_key_envelopes` (\n\t`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`kind` text NOT NULL,\n\t`wrapped_dek` blob NOT NULL,\n\t`kdf_salt` blob,\n\t`kdf_ops` integer,\n\t`kdf_mem` integer,\n\t`credential_id` text,\n\t`created_at` text NOT NULL,\n\tCONSTRAINT \"key_envelopes_credential_id_only_passkey\" CHECK((\"kind\" = 'passkey') = (\"credential_id\" IS NOT NULL))\n);\n",
      "\nINSERT INTO `__new_key_envelopes`(\"kind\", \"wrapped_dek\", \"kdf_salt\", \"kdf_ops\", \"kdf_mem\", \"credential_id\", \"created_at\") SELECT \"kind\", \"wrapped_dek\", \"kdf_salt\", \"kdf_ops\", \"kdf_mem\", \"credential_id\", \"created_at\" FROM `key_envelopes`;",
      "\nDROP TABLE `key_envelopes`;",
      "\nALTER TABLE `__new_key_envelopes` RENAME TO `key_envelopes`;",
      "\nPRAGMA foreign_keys=ON;",
      "\nCREATE UNIQUE INDEX `key_envelopes_kind_unique` ON `key_envelopes` (`kind`) WHERE \"kind\" <> 'passkey';",
      "\nCREATE UNIQUE INDEX `key_envelopes_passkey_credential_unique` ON `key_envelopes` (`credential_id`) WHERE \"kind\" = 'passkey';"
    ]
  }
];
