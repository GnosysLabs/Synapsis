CREATE TABLE `stuffbox_connections` (
	`user_id` text PRIMARY KEY,
	`base_url` text NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`access_token_expires_at` integer NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`refresh_token_expires_at` integer,
	`scopes` text NOT NULL,
	`connected_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_stuffbox_connections_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `media` ADD `storage_provider` text;--> statement-breakpoint
ALTER TABLE `media` ADD `storage_asset_id` text;