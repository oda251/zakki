CREATE TABLE `account_identities` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`account_id` text NOT NULL,
	`email` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`provider`, `subject`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_identities_account` ON `account_identities` (`account_id`);--> statement-breakpoint
CREATE TABLE `login_handoffs` (
	`code` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oidc_states` (
	`state` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`code_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oidc_states_expires` ON `oidc_states` (`expires_at`);--> statement-breakpoint
DROP TABLE `auth_challenges`;--> statement-breakpoint
DROP TABLE `credentials`;