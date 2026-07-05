-- 統合チャンクモデルへの移行（docs/CHUNKS.md, 2026-07-06）。
-- sessions / entries を廃止し、chunks を自己参照ツリーへ再構築する。
-- libsql の migrate バッチは FK 無効で実行されるため、テーブル再構築
-- （create → copy → drop → rename）が安全に行える。chunk id は保存する
-- （links / chunk_tags / embeddings は無変更で整合する）。
-- mig_session_id / mig_container は移行中だけの作業列で、最後に DROP する。
CREATE TABLE `chunks_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`date` text,
	`polarity` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`mig_session_id` integer,
	`mig_container` integer NOT NULL DEFAULT 0,
	FOREIGN KEY (`parent_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 1. 既存の本文チャンクを id 保存で移送（親は後段で配線）
INSERT INTO `chunks_new` (`id`, `parent_id`, `position`, `content`, `date`, `polarity`, `created_at`, `updated_at`, `mig_session_id`, `mig_container`)
SELECT c.`id`, NULL, c.`position`, c.`content`, NULL, c.`polarity`, c.`created_at`, c.`updated_at`, e.`session_id`, 0
FROM `chunks` c JOIN `entries` e ON c.`entry_id` = e.`id`;
--> statement-breakpoint
-- 2. 日付チャンク（トップレベル・1 日 1 件）。content は date と同値の平文
INSERT INTO `chunks_new` (`parent_id`, `position`, `content`, `date`, `polarity`, `created_at`, `updated_at`, `mig_session_id`, `mig_container`)
SELECT NULL, 0, s.`date`, s.`date`, NULL, MIN(s.`created_at`), MIN(s.`created_at`), NULL, 0
FROM `sessions` s GROUP BY s.`date`;
--> statement-breakpoint
-- 3. 旧・名前付きセッション → コンテナチャンク（content = name）。
--    position は同日のデフォルトセッション本文チャンク数の直後に連番で置き、
--    日付バッファの position 空間（0..n-1 が本文行）と衝突させない
INSERT INTO `chunks_new` (`parent_id`, `position`, `content`, `date`, `polarity`, `created_at`, `updated_at`, `mig_session_id`, `mig_container`)
SELECT NULL,
	(SELECT COUNT(*) FROM `chunks` c JOIN `entries` e ON c.`entry_id` = e.`id` JOIN `sessions` ds ON e.`session_id` = ds.`id`
		WHERE ds.`date` = s.`date` AND ds.`name` IS NULL)
	+ (SELECT COUNT(*) FROM `sessions` s2 WHERE s2.`date` = s.`date` AND s2.`name` IS NOT NULL AND s2.`id` < s.`id`),
	s.`name`, NULL, NULL, s.`created_at`, s.`updated_at`, s.`id`, 1
FROM `sessions` s WHERE s.`name` IS NOT NULL;
--> statement-breakpoint
-- 4a. デフォルトセッションの本文チャンク → 日付チャンクの子
UPDATE `chunks_new` SET `parent_id` = (
	SELECT dc.`id` FROM `chunks_new` dc
	WHERE dc.`date` = (SELECT s.`date` FROM `sessions` s WHERE s.`id` = `chunks_new`.`mig_session_id`)
) WHERE `mig_container` = 0 AND `mig_session_id` IN (SELECT `id` FROM `sessions` WHERE `name` IS NULL);
--> statement-breakpoint
-- 4b. 名前付きセッションの本文チャンク → コンテナの子
UPDATE `chunks_new` SET `parent_id` = (
	SELECT cc.`id` FROM `chunks_new` cc
	WHERE cc.`mig_container` = 1 AND cc.`mig_session_id` = `chunks_new`.`mig_session_id`
) WHERE `mig_container` = 0 AND `mig_session_id` IN (SELECT `id` FROM `sessions` WHERE `name` IS NOT NULL);
--> statement-breakpoint
-- 4c. コンテナ → 日付チャンクの子
UPDATE `chunks_new` SET `parent_id` = (
	SELECT dc.`id` FROM `chunks_new` dc
	WHERE dc.`date` = (SELECT s.`date` FROM `sessions` s WHERE s.`id` = `chunks_new`.`mig_session_id`)
) WHERE `mig_container` = 1;
--> statement-breakpoint
CREATE TABLE `chunk_user_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chunk_id` integer NOT NULL,
	`name` text NOT NULL,
	`name_fingerprint` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 5. セッションタグ → 対応チャンク（名前付き=コンテナ / デフォルト=日付チャンク）のユーザタグ
INSERT INTO `chunk_user_tags` (`chunk_id`, `name`, `name_fingerprint`, `created_at`)
SELECT COALESCE(
	(SELECT cc.`id` FROM `chunks_new` cc WHERE cc.`mig_container` = 1 AND cc.`mig_session_id` = st.`session_id`),
	(SELECT dc.`id` FROM `chunks_new` dc WHERE dc.`date` = (SELECT s.`date` FROM `sessions` s WHERE s.`id` = st.`session_id`))
), st.`name`, st.`name_fingerprint`, st.`created_at`
FROM `session_tags` st;
--> statement-breakpoint
CREATE TABLE `aad_fixups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`row_id` integer NOT NULL
);
--> statement-breakpoint
-- 6. 暗号 ON の DB 用: 旧 AAD のまま移送した暗号文の付替え予約
--    （コンテナ content は旧 "session.name"、ユーザタグ name は旧 "sessionTag.name"）。
--    暗号 OFF の DB では平文のまま正しく、アンロック時に行が消えるだけ
INSERT INTO `aad_fixups` (`kind`, `row_id`) SELECT 'chunk.content', `id` FROM `chunks_new` WHERE `mig_container` = 1;
--> statement-breakpoint
INSERT INTO `aad_fixups` (`kind`, `row_id`) SELECT 'chunkUserTag.name', `id` FROM `chunk_user_tags`;
--> statement-breakpoint
ALTER TABLE `chunks_new` DROP COLUMN `mig_session_id`;
--> statement-breakpoint
ALTER TABLE `chunks_new` DROP COLUMN `mig_container`;
--> statement-breakpoint
DROP TABLE `chunks`;
--> statement-breakpoint
DROP TABLE `entries`;
--> statement-breakpoint
DROP TABLE `session_tags`;
--> statement-breakpoint
DROP TABLE `sessions`;
--> statement-breakpoint
ALTER TABLE `chunks_new` RENAME TO `chunks`;
--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_parent_position` ON `chunks` (`parent_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_date_unique` ON `chunks` (`date`) WHERE "date" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `chunk_user_tags_unique` ON `chunk_user_tags` (`chunk_id`,`name_fingerprint`);
