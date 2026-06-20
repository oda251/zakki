CREATE TABLE `crypto_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`wrapped_dek` blob NOT NULL,
	`kek_salt` blob,
	`created_at` text NOT NULL
);
--> statement-breakpoint
DROP INDEX `tags_name_unique`;--> statement-breakpoint
ALTER TABLE `tags` ADD `name_fingerprint` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `tags` SET `name_fingerprint` = `name` WHERE `name_fingerprint` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_fingerprint_unique` ON `tags` (`name_fingerprint`);
