CREATE TABLE `cli_authorization_requests` (
	`id` text PRIMARY KEY,
	`device_code_hash` text NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`public_key_fingerprint` text NOT NULL,
	`scopes` text NOT NULL,
	`credential_lifetime_days` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`credential_id` text,
	`approved_by_user_id` text,
	`approved_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_cli_authorization_requests_credential_id_cli_credentials_id_fk` FOREIGN KEY (`credential_id`) REFERENCES `cli_credentials`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_cli_authorization_requests_approved_by_user_id_users_id_fk` FOREIGN KEY (`approved_by_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `cli_credentials` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`public_key` text NOT NULL,
	`public_key_fingerprint` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_cli_credentials_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_authorization_requests_device_code_unique` ON `cli_authorization_requests` (`device_code_hash`);--> statement-breakpoint
CREATE INDEX `cli_authorization_requests_expires_idx` ON `cli_authorization_requests` (`expires_at`);--> statement-breakpoint
CREATE INDEX `cli_authorization_requests_status_idx` ON `cli_authorization_requests` (`status`);--> statement-breakpoint
CREATE INDEX `cli_credentials_user_idx` ON `cli_credentials` (`user_id`);--> statement-breakpoint
CREATE INDEX `cli_credentials_expires_idx` ON `cli_credentials` (`expires_at`);--> statement-breakpoint
CREATE INDEX `cli_credentials_fingerprint_idx` ON `cli_credentials` (`public_key_fingerprint`);
