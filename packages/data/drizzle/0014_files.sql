-- issue #157: chunks に kind / file_id を追加（CHECK 制約付き）するため drizzle-kit が
-- テーブル再構築を生成する。0013 と同じ理由で 1 箇所だけ手を入れている: 新設の
-- kind / file_id は旧表に存在しないので INSERT ... SELECT の列一覧から外す
-- （生成のままだと "no such column: kind" で落ちる）。列を外すと kind は DEFAULT
-- 'text' に採番され、file_id は NULL になる（既存行はすべてテキストチャンクなので
-- 要件どおり: A1「migration 適用後、既存チャンク行の kind は 'text' になる」）。
-- id は列一覧から外していない: links / chunk_tags / embeddings / chunk_user_tags が
-- chunks.id を FK 参照しており、id が変わると全部壊れるため必ず移送する。
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`extension` text NOT NULL,
	`encryption` text NOT NULL,
	`object_key` text NOT NULL,
	`size` integer NOT NULL,
	`part_size` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`date` text,
	`polarity` real,
	`kind` text DEFAULT 'text' NOT NULL,
	`file_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chunks_file_id_only_blob" CHECK(("kind" = 'blob') = ("file_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_chunks`("id", "parent_id", "position", "content", "date", "polarity", "created_at", "updated_at") SELECT "id", "parent_id", "position", "content", "date", "polarity", "created_at", "updated_at" FROM `chunks`;--> statement-breakpoint
DROP TABLE `chunks`;--> statement-breakpoint
ALTER TABLE `__new_chunks` RENAME TO `chunks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_parent_position` ON `chunks` (`parent_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `chunks_date_unique` ON `chunks` (`date`) WHERE "date" IS NOT NULL;