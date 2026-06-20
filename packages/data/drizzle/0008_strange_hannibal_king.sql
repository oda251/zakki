CREATE TABLE `key_envelopes` (
	`kind` text PRIMARY KEY NOT NULL,
	`wrapped_dek` blob NOT NULL,
	`kdf_salt` blob,
	`kdf_ops` integer,
	`kdf_mem` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `key_envelopes` (`kind`, `wrapped_dek`, `kdf_salt`, `kdf_ops`, `kdf_mem`, `created_at`)
SELECT 'keyfile', `wrapped_dek`, NULL, NULL, NULL, `created_at` FROM `crypto_meta` WHERE `id` = 1;
