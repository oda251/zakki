-- issue #120: key_envelopes の主キーを kind から代理キー(id)へ。単数 kind と
-- 「passkey は credential ごと」を部分ユニークインデックスで表す。
-- drizzle-kit 生成のテーブル再構築に 1 箇所だけ手を入れている: 新設の id は旧表に
-- 存在しないので INSERT ... SELECT の列一覧から外し、AUTOINCREMENT に採番させる
-- （既存行はそのまま移送される。生成のままだと "no such column: id" で落ちる）。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_key_envelopes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`wrapped_dek` blob NOT NULL,
	`kdf_salt` blob,
	`kdf_ops` integer,
	`kdf_mem` integer,
	`credential_id` text,
	`created_at` text NOT NULL,
	CONSTRAINT "key_envelopes_credential_id_only_passkey" CHECK(("kind" = 'passkey') = ("credential_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_key_envelopes`("kind", "wrapped_dek", "kdf_salt", "kdf_ops", "kdf_mem", "credential_id", "created_at") SELECT "kind", "wrapped_dek", "kdf_salt", "kdf_ops", "kdf_mem", "credential_id", "created_at" FROM `key_envelopes`;--> statement-breakpoint
DROP TABLE `key_envelopes`;--> statement-breakpoint
ALTER TABLE `__new_key_envelopes` RENAME TO `key_envelopes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `key_envelopes_kind_unique` ON `key_envelopes` (`kind`) WHERE "kind" <> 'passkey';--> statement-breakpoint
CREATE UNIQUE INDEX `key_envelopes_passkey_credential_unique` ON `key_envelopes` (`credential_id`) WHERE "kind" = 'passkey';