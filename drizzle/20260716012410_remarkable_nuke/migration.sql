PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_posts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`reply_to_id` text,
	`repost_of_id` text,
	`swarm_reply_to_id` text,
	`swarm_reply_to_content` text,
	`swarm_reply_to_author` text,
	`likes_count` integer DEFAULT 0 NOT NULL,
	`reposts_count` integer DEFAULT 0 NOT NULL,
	`replies_count` integer DEFAULT 0 NOT NULL,
	`is_nsfw` integer DEFAULT false NOT NULL,
	`is_removed` integer DEFAULT false NOT NULL,
	`removed_at` integer,
	`removed_by` text,
	`removed_reason` text,
	`ap_id` text UNIQUE,
	`ap_url` text,
	`link_preview_url` text,
	`link_preview_title` text,
	`link_preview_description` text,
	`link_preview_image` text,
	`link_preview_type` text,
	`link_preview_video_url` text,
	`link_preview_media_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_posts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_posts_removed_by_users_id_fk` FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_posts`(`id`, `user_id`, `content`, `reply_to_id`, `repost_of_id`, `swarm_reply_to_id`, `swarm_reply_to_content`, `swarm_reply_to_author`, `likes_count`, `reposts_count`, `replies_count`, `is_nsfw`, `is_removed`, `removed_at`, `removed_by`, `removed_reason`, `ap_id`, `ap_url`, `link_preview_url`, `link_preview_title`, `link_preview_description`, `link_preview_image`, `link_preview_type`, `link_preview_video_url`, `link_preview_media_json`, `created_at`, `updated_at`) SELECT `id`, `user_id`, `content`, `reply_to_id`, `repost_of_id`, `swarm_reply_to_id`, `swarm_reply_to_content`, `swarm_reply_to_author`, `likes_count`, `reposts_count`, `replies_count`, `is_nsfw`, `is_removed`, `removed_at`, `removed_by`, `removed_reason`, `ap_id`, `ap_url`, `link_preview_url`, `link_preview_title`, `link_preview_description`, `link_preview_image`, `link_preview_type`, `link_preview_video_url`, `link_preview_media_json`, `created_at`, `updated_at` FROM `posts`;--> statement-breakpoint
DROP TABLE `posts`;--> statement-breakpoint
ALTER TABLE `__new_posts` RENAME TO `posts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY,
	`did` text NOT NULL,
	`handle` text NOT NULL,
	`email` text UNIQUE,
	`password_hash` text,
	`display_name` text,
	`bio` text,
	`avatar_url` text,
	`header_url` text,
	`private_key_encrypted` text,
	`public_key` text NOT NULL,
	`node_id` text,
	`is_nsfw` integer DEFAULT false NOT NULL,
	`nsfw_enabled` integer DEFAULT false NOT NULL,
	`age_verified_at` integer,
	`is_suspended` integer DEFAULT false NOT NULL,
	`suspension_reason` text,
	`suspended_at` integer,
	`is_silenced` integer DEFAULT false NOT NULL,
	`silence_reason` text,
	`silenced_at` integer,
	`moved_to` text,
	`moved_from` text,
	`migrated_at` integer,
	`storage_provider` text,
	`storage_endpoint` text,
	`storage_public_base_url` text,
	`storage_region` text,
	`storage_bucket` text,
	`storage_access_key_encrypted` text,
	`storage_secret_key_encrypted` text,
	`followers_count` integer DEFAULT 0 NOT NULL,
	`following_count` integer DEFAULT 0 NOT NULL,
	`posts_count` integer DEFAULT 0 NOT NULL,
	`website` text,
	`dm_privacy` text DEFAULT 'everyone' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_users_node_id_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_users`(`id`, `did`, `handle`, `email`, `password_hash`, `display_name`, `bio`, `avatar_url`, `header_url`, `private_key_encrypted`, `public_key`, `node_id`, `is_nsfw`, `nsfw_enabled`, `age_verified_at`, `is_suspended`, `suspension_reason`, `suspended_at`, `is_silenced`, `silence_reason`, `silenced_at`, `moved_to`, `moved_from`, `migrated_at`, `storage_provider`, `storage_endpoint`, `storage_public_base_url`, `storage_region`, `storage_bucket`, `storage_access_key_encrypted`, `storage_secret_key_encrypted`, `followers_count`, `following_count`, `posts_count`, `website`, `dm_privacy`, `created_at`, `updated_at`) SELECT `id`, `did`, `handle`, `email`, `password_hash`, `display_name`, `bio`, `avatar_url`, `header_url`, `private_key_encrypted`, `public_key`, `node_id`, `is_nsfw`, `nsfw_enabled`, `age_verified_at`, `is_suspended`, `suspension_reason`, `suspended_at`, `is_silenced`, `silence_reason`, `silenced_at`, `moved_to`, `moved_from`, `migrated_at`, `storage_provider`, `storage_endpoint`, `storage_public_base_url`, `storage_region`, `storage_bucket`, `storage_access_key_encrypted`, `storage_secret_key_encrypted`, `followers_count`, `following_count`, `posts_count`, `website`, `dm_privacy`, `created_at`, `updated_at` FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_activity_logs_bot_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_activity_logs_action_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_activity_logs_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_content_items_source_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_content_items_processed_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_content_items_external_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_content_sources_bot_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_content_sources_type_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_mentions_bot_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_mentions_processed_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_mentions_created_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_mentions_bot_post_unique_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bot_rate_limits_bot_window_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bots_user_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bots_owner_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `bots_active_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `posts_bot_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `users_is_bot_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `users_bot_owner_idx`;--> statement-breakpoint
CREATE INDEX `posts_user_id_idx` ON `posts` (`user_id`);--> statement-breakpoint
CREATE INDEX `posts_created_at_idx` ON `posts` (`created_at`);--> statement-breakpoint
CREATE INDEX `posts_reply_to_idx` ON `posts` (`reply_to_id`);--> statement-breakpoint
CREATE INDEX `posts_removed_idx` ON `posts` (`is_removed`);--> statement-breakpoint
CREATE INDEX `posts_nsfw_idx` ON `posts` (`is_nsfw`);--> statement-breakpoint
CREATE INDEX `users_handle_idx` ON `users` (`handle`);--> statement-breakpoint
CREATE INDEX `users_did_idx` ON `users` (`did`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique_idx` ON `users` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_did_unique_idx` ON `users` (`did`);--> statement-breakpoint
CREATE INDEX `users_suspended_idx` ON `users` (`is_suspended`);--> statement-breakpoint
CREATE INDEX `users_silenced_idx` ON `users` (`is_silenced`);--> statement-breakpoint
CREATE INDEX `users_nsfw_idx` ON `users` (`is_nsfw`);--> statement-breakpoint
DROP TABLE `bot_activity_logs`;--> statement-breakpoint
DROP TABLE `bot_content_items`;--> statement-breakpoint
DROP TABLE `bot_content_sources`;--> statement-breakpoint
DROP TABLE `bot_mentions`;--> statement-breakpoint
DROP TABLE `bot_rate_limits`;--> statement-breakpoint
DROP TABLE `bots`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `target_handle`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `target_display_name`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `target_avatar_url`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `target_node_domain`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `target_is_bot`;