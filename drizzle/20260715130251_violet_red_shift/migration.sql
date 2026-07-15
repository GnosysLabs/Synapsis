CREATE TABLE `e2ee_key_bundles` (
	`user_id` text PRIMARY KEY,
	`did` text NOT NULL,
	`key_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`public_key` text NOT NULL,
	`proof_action` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_e2ee_key_bundles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `e2ee_key_vaults` (
	`user_id` text PRIMARY KEY,
	`key_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`owner_did` text NOT NULL,
	`public_key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`salt` text NOT NULL,
	`kdf_algorithm` text NOT NULL,
	`kdf_ops_limit` integer NOT NULL,
	`kdf_mem_limit` integer NOT NULL,
	`pin_verifier_mac` text NOT NULL,
	`server_share_encrypted` text NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_e2ee_key_vaults_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `e2ee_message_receipts` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`sender_did` text NOT NULL,
	`message_id` text NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_e2ee_message_receipts_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `e2ee_remote_key_bundles` (
	`did` text PRIMARY KEY,
	`handle` text NOT NULL,
	`key_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`public_key` text NOT NULL,
	`proof_action` text NOT NULL,
	`signing_public_key` text NOT NULL,
	`first_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `chat_conversations` ADD `encryption_mode` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_conversations` ADD `e2ee_activated_at` integer;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `protocol_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `client_message_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `encrypted_envelope` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `e2ee_signature` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `e2ee_action_nonce` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `e2ee_action_ts` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_messages_conversation_client_id_unique` ON `chat_messages` (`conversation_id`,`client_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `e2ee_key_bundles_did_unique` ON `e2ee_key_bundles` (`did`);--> statement-breakpoint
CREATE UNIQUE INDEX `e2ee_key_bundles_key_id_unique` ON `e2ee_key_bundles` (`key_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `e2ee_key_vaults_key_id_unique` ON `e2ee_key_vaults` (`key_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `e2ee_message_receipts_owner_sender_message_unique` ON `e2ee_message_receipts` (`owner_user_id`,`sender_did`,`message_id`);--> statement-breakpoint
CREATE INDEX `e2ee_message_receipts_received_idx` ON `e2ee_message_receipts` (`received_at`);--> statement-breakpoint
CREATE INDEX `e2ee_remote_key_bundles_key_id_idx` ON `e2ee_remote_key_bundles` (`key_id`);--> statement-breakpoint
CREATE INDEX `e2ee_remote_key_bundles_handle_idx` ON `e2ee_remote_key_bundles` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique_idx` ON `users` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_did_unique_idx` ON `users` (`did`);