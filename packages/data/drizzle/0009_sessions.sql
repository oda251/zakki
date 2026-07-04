CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`date` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_default_date` ON `sessions` (`date`) WHERE "name" IS NULL;--> statement-breakpoint
CREATE TABLE `session_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`name` text NOT NULL,
	`name_fingerprint` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_tags_unique` ON `session_tags` (`session_id`,`name_fingerprint`);--> statement-breakpoint
INSERT INTO `sessions` (`name`, `date`, `created_at`, `updated_at`)
SELECT NULL, `date`, `created_at`, `updated_at` FROM `entries`;--> statement-breakpoint
CREATE TABLE `__new_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`date` text NOT NULL,
	`raw` text DEFAULT '' NOT NULL,
	`converted` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_entries` (`id`, `session_id`, `date`, `raw`, `converted`, `created_at`, `updated_at`)
SELECT e.`id`, s.`id`, e.`date`, e.`raw`, e.`converted`, e.`created_at`, e.`updated_at`
FROM `entries` e JOIN `sessions` s ON s.`date` = e.`date` AND s.`name` IS NULL;--> statement-breakpoint
DROP TABLE `entries`;--> statement-breakpoint
ALTER TABLE `__new_entries` RENAME TO `entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `entries_session_unique` ON `entries` (`session_id`);
