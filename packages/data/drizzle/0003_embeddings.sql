CREATE TABLE `embeddings` (
	`chunk_id` integer PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`model` text NOT NULL,
	`vector` blob NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `chunks`(`id`) ON UPDATE no action ON DELETE cascade
);
