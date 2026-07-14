CREATE TABLE `blocks` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`blocked_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_blocks_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_blocks_blocked_user_id_users_id_fk` FOREIGN KEY (`blocked_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `bot_activity_logs` (
	`id` text PRIMARY KEY,
	`bot_id` text NOT NULL,
	`action` text NOT NULL,
	`details` text NOT NULL,
	`success` integer NOT NULL,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_bot_activity_logs_bot_id_bots_id_fk` FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `bot_content_items` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text,
	`url` text NOT NULL,
	`published_at` integer NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
	`is_processed` integer DEFAULT false NOT NULL,
	`processed_at` integer,
	`post_id` text,
	`interest_score` integer,
	`interest_reason` text,
	CONSTRAINT `fk_bot_content_items_source_id_bot_content_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `bot_content_sources`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_bot_content_items_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `bot_content_sources` (
	`id` text PRIMARY KEY,
	`bot_id` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`subreddit` text,
	`api_key_encrypted` text,
	`source_config` text,
	`keywords` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_fetch_at` integer,
	`last_error` text,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_bot_content_sources_bot_id_bots_id_fk` FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `bot_mentions` (
	`id` text PRIMARY KEY,
	`bot_id` text NOT NULL,
	`post_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`is_processed` integer DEFAULT false NOT NULL,
	`processed_at` integer,
	`response_post_id` text,
	`is_remote` integer DEFAULT false NOT NULL,
	`remote_actor_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_bot_mentions_bot_id_bots_id_fk` FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_bot_mentions_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_bot_mentions_author_id_users_id_fk` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_bot_mentions_response_post_id_posts_id_fk` FOREIGN KEY (`response_post_id`) REFERENCES `posts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `bot_rate_limits` (
	`id` text PRIMARY KEY,
	`bot_id` text NOT NULL,
	`window_start` integer NOT NULL,
	`window_type` text NOT NULL,
	`post_count` integer DEFAULT 0 NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_bot_rate_limits_bot_id_bots_id_fk` FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `bots` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`personality_config` text NOT NULL,
	`llm_provider` text NOT NULL,
	`llm_model` text NOT NULL,
	`llm_endpoint` text,
	`llm_api_key_encrypted` text NOT NULL,
	`schedule_config` text,
	`autonomous_mode` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_suspended` integer DEFAULT false NOT NULL,
	`suspension_reason` text,
	`suspended_at` integer,
	`last_post_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_bots_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_bots_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `chat_conversations` (
	`id` text PRIMARY KEY,
	`type` text DEFAULT 'direct' NOT NULL,
	`participant1_id` text NOT NULL,
	`participant2_handle` text NOT NULL,
	`last_message_at` integer,
	`last_message_preview` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_chat_conversations_participant1_id_users_id_fk` FOREIGN KEY (`participant1_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`sender_handle` text NOT NULL,
	`sender_display_name` text,
	`sender_avatar_url` text,
	`sender_node_domain` text,
	`sender_did` text,
	`content` text,
	`swarm_message_id` text,
	`delivered_at` integer,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_chat_messages_conversation_id_chat_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `chat_typing_indicators` (
	`id` text PRIMARY KEY,
	`conversation_id` text NOT NULL,
	`user_handle` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_chat_typing_indicators_conversation_id_chat_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `chat_conversations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `follows` (
	`id` text PRIMARY KEY,
	`follower_id` text NOT NULL,
	`following_id` text NOT NULL,
	`ap_id` text UNIQUE,
	`pending` integer DEFAULT false,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_follows_follower_id_users_id_fk` FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_follows_following_id_users_id_fk` FOREIGN KEY (`following_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `handle_registry` (
	`handle` text PRIMARY KEY,
	`did` text NOT NULL,
	`node_domain` text NOT NULL,
	`registered_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `likes` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`post_id` text NOT NULL,
	`ap_id` text UNIQUE,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_likes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_likes_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`post_id` text,
	`url` text NOT NULL,
	`alt_text` text,
	`mime_type` text,
	`width` integer,
	`height` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_media_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_media_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `muted_nodes` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`node_domain` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_muted_nodes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mutes` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`muted_user_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_mutes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_mutes_muted_user_id_users_id_fk` FOREIGN KEY (`muted_user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY,
	`domain` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`description` text,
	`long_description` text,
	`rules` text,
	`banner_url` text,
	`logo_url` text,
	`favicon_url` text,
	`logo_data` text,
	`favicon_data` text,
	`accent_color` text DEFAULT '#FFFFFF',
	`public_key` text,
	`private_key_encrypted` text,
	`is_nsfw` integer DEFAULT false NOT NULL,
	`turnstile_site_key` text,
	`turnstile_secret_key` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`actor_id` text,
	`actor_handle` text NOT NULL,
	`actor_display_name` text,
	`actor_avatar_url` text,
	`actor_node_domain` text,
	`target_handle` text,
	`target_display_name` text,
	`target_avatar_url` text,
	`target_node_domain` text,
	`target_is_bot` integer,
	`post_id` text,
	`post_content` text,
	`type` text NOT NULL,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_notifications_actor_id_users_id_fk` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_notifications_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`bot_id` text,
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
	CONSTRAINT `fk_posts_bot_id_bots_id_fk` FOREIGN KEY (`bot_id`) REFERENCES `bots`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_posts_removed_by_users_id_fk` FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `remote_followers` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`actor_url` text NOT NULL,
	`inbox_url` text NOT NULL,
	`shared_inbox_url` text,
	`handle` text,
	`activity_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_remote_followers_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `remote_follows` (
	`id` text PRIMARY KEY,
	`follower_id` text NOT NULL,
	`target_handle` text NOT NULL,
	`target_actor_url` text NOT NULL,
	`inbox_url` text NOT NULL,
	`activity_id` text NOT NULL,
	`display_name` text,
	`bio` text,
	`avatar_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_remote_follows_follower_id_users_id_fk` FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `remote_identity_cache` (
	`did` text PRIMARY KEY,
	`public_key` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remote_likes` (
	`id` text PRIMARY KEY,
	`post_id` text NOT NULL,
	`actor_handle` text NOT NULL,
	`actor_node_domain` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_remote_likes_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `remote_posts` (
	`id` text PRIMARY KEY,
	`ap_id` text NOT NULL,
	`author_handle` text NOT NULL,
	`author_actor_url` text NOT NULL,
	`author_display_name` text,
	`author_avatar_url` text,
	`content` text NOT NULL,
	`published_at` integer NOT NULL,
	`link_preview_url` text,
	`link_preview_title` text,
	`link_preview_description` text,
	`link_preview_image` text,
	`link_preview_type` text,
	`link_preview_video_url` text,
	`link_preview_media_json` text,
	`media_json` text,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remote_reposts` (
	`id` text PRIMARY KEY,
	`post_id` text NOT NULL,
	`actor_handle` text NOT NULL,
	`actor_node_domain` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_remote_reposts_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY,
	`reporter_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`resolution_note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_reports_reporter_id_users_id_fk` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_reports_resolved_by_users_id_fk` FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `signed_action_dedupe` (
	`action_id` text PRIMARY KEY,
	`did` text NOT NULL,
	`nonce` text NOT NULL,
	`ts` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `swarm_nodes` (
	`id` text PRIMARY KEY,
	`domain` text NOT NULL,
	`name` text,
	`description` text,
	`logo_url` text,
	`public_key` text,
	`software_version` text,
	`user_count` integer,
	`post_count` integer,
	`is_nsfw` integer DEFAULT false NOT NULL,
	`discovered_via` text,
	`discovered_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_sync_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`trust_score` integer DEFAULT 50 NOT NULL,
	`is_blocked` integer DEFAULT false NOT NULL,
	`block_reason` text,
	`blocked_at` integer,
	`capabilities` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `swarm_seeds` (
	`id` text PRIMARY KEY,
	`domain` text NOT NULL UNIQUE,
	`priority` integer DEFAULT 100 NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`last_contact_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `swarm_sync_log` (
	`id` text PRIMARY KEY,
	`remote_domain` text NOT NULL,
	`direction` text NOT NULL,
	`nodes_received` integer DEFAULT 0 NOT NULL,
	`nodes_sent` integer DEFAULT 0 NOT NULL,
	`handles_received` integer DEFAULT 0 NOT NULL,
	`handles_sent` integer DEFAULT 0 NOT NULL,
	`success` integer NOT NULL,
	`error_message` text,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_swarm_likes` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`node_domain` text NOT NULL,
	`original_post_id` text NOT NULL,
	`author_handle` text NOT NULL,
	`author_display_name` text,
	`author_avatar_url` text,
	`content` text NOT NULL,
	`post_created_at` integer NOT NULL,
	`likes_count` integer DEFAULT 0 NOT NULL,
	`reposts_count` integer DEFAULT 0 NOT NULL,
	`replies_count` integer DEFAULT 0 NOT NULL,
	`link_preview_url` text,
	`link_preview_title` text,
	`link_preview_description` text,
	`link_preview_image` text,
	`link_preview_type` text,
	`link_preview_video_url` text,
	`link_preview_media_json` text,
	`media_json` text,
	`liked_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_user_swarm_likes_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user_swarm_reposts` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`node_domain` text NOT NULL,
	`original_post_id` text NOT NULL,
	`author_handle` text NOT NULL,
	`author_display_name` text,
	`author_avatar_url` text,
	`content` text NOT NULL,
	`post_created_at` integer NOT NULL,
	`likes_count` integer DEFAULT 0 NOT NULL,
	`reposts_count` integer DEFAULT 0 NOT NULL,
	`replies_count` integer DEFAULT 0 NOT NULL,
	`link_preview_url` text,
	`link_preview_title` text,
	`link_preview_description` text,
	`link_preview_image` text,
	`link_preview_type` text,
	`link_preview_video_url` text,
	`link_preview_media_json` text,
	`media_json` text,
	`reposted_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_user_swarm_reposts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
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
	`is_bot` integer DEFAULT false NOT NULL,
	`bot_owner_id` text,
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
	CONSTRAINT `fk_users_node_id_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`),
	CONSTRAINT `users_bot_owner_id_users_id_fk` FOREIGN KEY (`bot_owner_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `blocks_user_idx` ON `blocks` (`user_id`);--> statement-breakpoint
CREATE INDEX `blocks_blocked_user_idx` ON `blocks` (`blocked_user_id`);--> statement-breakpoint
CREATE INDEX `bot_activity_logs_bot_idx` ON `bot_activity_logs` (`bot_id`);--> statement-breakpoint
CREATE INDEX `bot_activity_logs_action_idx` ON `bot_activity_logs` (`action`);--> statement-breakpoint
CREATE INDEX `bot_activity_logs_created_idx` ON `bot_activity_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `bot_content_items_source_idx` ON `bot_content_items` (`source_id`);--> statement-breakpoint
CREATE INDEX `bot_content_items_processed_idx` ON `bot_content_items` (`is_processed`);--> statement-breakpoint
CREATE INDEX `bot_content_items_external_idx` ON `bot_content_items` (`external_id`);--> statement-breakpoint
CREATE INDEX `bot_content_sources_bot_idx` ON `bot_content_sources` (`bot_id`);--> statement-breakpoint
CREATE INDEX `bot_content_sources_type_idx` ON `bot_content_sources` (`type`);--> statement-breakpoint
CREATE INDEX `bot_mentions_bot_idx` ON `bot_mentions` (`bot_id`);--> statement-breakpoint
CREATE INDEX `bot_mentions_processed_idx` ON `bot_mentions` (`is_processed`);--> statement-breakpoint
CREATE INDEX `bot_mentions_created_idx` ON `bot_mentions` (`created_at`);--> statement-breakpoint
CREATE INDEX `bot_rate_limits_bot_window_idx` ON `bot_rate_limits` (`bot_id`,`window_start`);--> statement-breakpoint
CREATE INDEX `bots_user_id_idx` ON `bots` (`user_id`);--> statement-breakpoint
CREATE INDEX `bots_owner_id_idx` ON `bots` (`owner_id`);--> statement-breakpoint
CREATE INDEX `bots_active_idx` ON `bots` (`is_active`);--> statement-breakpoint
CREATE INDEX `chat_conversations_participant1_idx` ON `chat_conversations` (`participant1_id`);--> statement-breakpoint
CREATE INDEX `chat_conversations_last_message_idx` ON `chat_conversations` (`last_message_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_conversations_unique` ON `chat_conversations` (`participant1_id`,`participant2_handle`);--> statement-breakpoint
CREATE INDEX `chat_messages_conversation_idx` ON `chat_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `chat_messages_created_idx` ON `chat_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_swarm_id_idx` ON `chat_messages` (`swarm_message_id`);--> statement-breakpoint
CREATE INDEX `chat_typing_conversation_idx` ON `chat_typing_indicators` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `chat_typing_expires_idx` ON `chat_typing_indicators` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_typing_unique` ON `chat_typing_indicators` (`conversation_id`,`user_handle`);--> statement-breakpoint
CREATE INDEX `follows_follower_idx` ON `follows` (`follower_id`);--> statement-breakpoint
CREATE INDEX `follows_following_idx` ON `follows` (`following_id`);--> statement-breakpoint
CREATE INDEX `handle_registry_updated_idx` ON `handle_registry` (`updated_at`);--> statement-breakpoint
CREATE INDEX `likes_user_post_idx` ON `likes` (`user_id`,`post_id`);--> statement-breakpoint
CREATE INDEX `media_user_idx` ON `media` (`user_id`);--> statement-breakpoint
CREATE INDEX `media_post_idx` ON `media` (`post_id`);--> statement-breakpoint
CREATE INDEX `muted_nodes_user_idx` ON `muted_nodes` (`user_id`);--> statement-breakpoint
CREATE INDEX `muted_nodes_domain_idx` ON `muted_nodes` (`node_domain`);--> statement-breakpoint
CREATE INDEX `mutes_user_idx` ON `mutes` (`user_id`);--> statement-breakpoint
CREATE INDEX `mutes_muted_user_idx` ON `mutes` (`muted_user_id`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE INDEX `posts_user_id_idx` ON `posts` (`user_id`);--> statement-breakpoint
CREATE INDEX `posts_bot_id_idx` ON `posts` (`bot_id`);--> statement-breakpoint
CREATE INDEX `posts_created_at_idx` ON `posts` (`created_at`);--> statement-breakpoint
CREATE INDEX `posts_reply_to_idx` ON `posts` (`reply_to_id`);--> statement-breakpoint
CREATE INDEX `posts_removed_idx` ON `posts` (`is_removed`);--> statement-breakpoint
CREATE INDEX `posts_nsfw_idx` ON `posts` (`is_nsfw`);--> statement-breakpoint
CREATE INDEX `remote_followers_user_idx` ON `remote_followers` (`user_id`);--> statement-breakpoint
CREATE INDEX `remote_followers_actor_idx` ON `remote_followers` (`actor_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_followers_user_actor_unique` ON `remote_followers` (`user_id`,`actor_url`);--> statement-breakpoint
CREATE INDEX `remote_follows_follower_idx` ON `remote_follows` (`follower_id`);--> statement-breakpoint
CREATE INDEX `remote_follows_target_idx` ON `remote_follows` (`target_handle`);--> statement-breakpoint
CREATE INDEX `remote_likes_post_idx` ON `remote_likes` (`post_id`);--> statement-breakpoint
CREATE INDEX `remote_likes_actor_idx` ON `remote_likes` (`actor_handle`,`actor_node_domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_likes_unique` ON `remote_likes` (`post_id`,`actor_handle`,`actor_node_domain`);--> statement-breakpoint
CREATE INDEX `remote_posts_author_idx` ON `remote_posts` (`author_handle`);--> statement-breakpoint
CREATE INDEX `remote_posts_published_idx` ON `remote_posts` (`published_at`);--> statement-breakpoint
CREATE INDEX `remote_posts_ap_id_idx` ON `remote_posts` (`ap_id`);--> statement-breakpoint
CREATE INDEX `remote_reposts_post_idx` ON `remote_reposts` (`post_id`);--> statement-breakpoint
CREATE INDEX `remote_reposts_actor_idx` ON `remote_reposts` (`actor_handle`,`actor_node_domain`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_reposts_unique` ON `remote_reposts` (`post_id`,`actor_handle`,`actor_node_domain`);--> statement-breakpoint
CREATE INDEX `reports_status_idx` ON `reports` (`status`);--> statement-breakpoint
CREATE INDEX `reports_target_idx` ON `reports` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `reports_reporter_idx` ON `reports` (`reporter_id`);--> statement-breakpoint
CREATE INDEX `sessions_token_idx` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `signed_action_dedupe_created_idx` ON `signed_action_dedupe` (`created_at`);--> statement-breakpoint
CREATE INDEX `swarm_nodes_domain_idx` ON `swarm_nodes` (`domain`);--> statement-breakpoint
CREATE INDEX `swarm_nodes_active_idx` ON `swarm_nodes` (`is_active`);--> statement-breakpoint
CREATE INDEX `swarm_nodes_last_seen_idx` ON `swarm_nodes` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `swarm_nodes_trust_idx` ON `swarm_nodes` (`trust_score`);--> statement-breakpoint
CREATE INDEX `swarm_nodes_nsfw_idx` ON `swarm_nodes` (`is_nsfw`);--> statement-breakpoint
CREATE INDEX `swarm_nodes_blocked_idx` ON `swarm_nodes` (`is_blocked`);--> statement-breakpoint
CREATE INDEX `swarm_seeds_enabled_idx` ON `swarm_seeds` (`is_enabled`);--> statement-breakpoint
CREATE INDEX `swarm_seeds_priority_idx` ON `swarm_seeds` (`priority`);--> statement-breakpoint
CREATE INDEX `swarm_sync_log_remote_idx` ON `swarm_sync_log` (`remote_domain`);--> statement-breakpoint
CREATE INDEX `swarm_sync_log_created_idx` ON `swarm_sync_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `user_swarm_likes_user_idx` ON `user_swarm_likes` (`user_id`,`liked_at`);--> statement-breakpoint
CREATE INDEX `user_swarm_likes_post_idx` ON `user_swarm_likes` (`node_domain`,`original_post_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_swarm_likes_unique` ON `user_swarm_likes` (`user_id`,`node_domain`,`original_post_id`);--> statement-breakpoint
CREATE INDEX `user_swarm_reposts_user_idx` ON `user_swarm_reposts` (`user_id`,`reposted_at`);--> statement-breakpoint
CREATE INDEX `user_swarm_reposts_post_idx` ON `user_swarm_reposts` (`node_domain`,`original_post_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_swarm_reposts_unique` ON `user_swarm_reposts` (`user_id`,`node_domain`,`original_post_id`);--> statement-breakpoint
CREATE INDEX `users_handle_idx` ON `users` (`handle`);--> statement-breakpoint
CREATE INDEX `users_did_idx` ON `users` (`did`);--> statement-breakpoint
CREATE INDEX `users_suspended_idx` ON `users` (`is_suspended`);--> statement-breakpoint
CREATE INDEX `users_silenced_idx` ON `users` (`is_silenced`);--> statement-breakpoint
CREATE INDEX `users_is_bot_idx` ON `users` (`is_bot`);--> statement-breakpoint
CREATE INDEX `users_bot_owner_idx` ON `users` (`bot_owner_id`);--> statement-breakpoint
CREATE INDEX `users_nsfw_idx` ON `users` (`is_nsfw`);