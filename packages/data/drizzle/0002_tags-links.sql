CREATE TABLE `chunk_tags` (
	`chunk_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`score` real NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chunk_tags_pair` ON `chunk_tags` (`chunk_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `links` (
	`from_chunk_id` integer NOT NULL,
	`to_chunk_id` integer NOT NULL,
	`score` real NOT NULL,
	`origin` text NOT NULL,
	FOREIGN KEY (`from_chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_pair` ON `links` (`from_chunk_id`,`to_chunk_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);