CREATE TABLE `repl_docs` (
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted` integer NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`collection`, `id`)
);
