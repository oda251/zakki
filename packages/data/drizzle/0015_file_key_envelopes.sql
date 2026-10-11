CREATE TABLE `file_key_envelopes` (
	`id` integer PRIMARY KEY NOT NULL,
	`wrapped_fek` blob NOT NULL,
	`kdf_salt` blob NOT NULL,
	`kdf_ops` integer NOT NULL,
	`kdf_mem` integer NOT NULL,
	`created_at` text NOT NULL
);
