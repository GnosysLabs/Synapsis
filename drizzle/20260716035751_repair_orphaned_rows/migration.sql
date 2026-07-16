-- Repair rows created while SQLite foreign-key enforcement was disabled.
-- The runtime now enables PRAGMA foreign_keys on every connection, so this is
-- a one-time cleanup for databases that predate that fix.

-- Remove records attached to local posts whose author no longer exists.
DELETE FROM `media`
WHERE `post_id` IN (
  SELECT `posts`.`id` FROM `posts`
  LEFT JOIN `users` ON `users`.`id` = `posts`.`user_id`
  WHERE `users`.`id` IS NULL
);--> statement-breakpoint
DELETE FROM `likes`
WHERE `post_id` IN (
  SELECT `posts`.`id` FROM `posts`
  LEFT JOIN `users` ON `users`.`id` = `posts`.`user_id`
  WHERE `users`.`id` IS NULL
);--> statement-breakpoint
DELETE FROM `remote_likes`
WHERE `post_id` IN (
  SELECT `posts`.`id` FROM `posts`
  LEFT JOIN `users` ON `users`.`id` = `posts`.`user_id`
  WHERE `users`.`id` IS NULL
);--> statement-breakpoint
DELETE FROM `remote_reposts`
WHERE `post_id` IN (
  SELECT `posts`.`id` FROM `posts`
  LEFT JOIN `users` ON `users`.`id` = `posts`.`user_id`
  WHERE `users`.`id` IS NULL
);--> statement-breakpoint
DELETE FROM `notifications`
WHERE `post_id` IN (
  SELECT `posts`.`id` FROM `posts`
  LEFT JOIN `users` ON `users`.`id` = `posts`.`user_id`
  WHERE `users`.`id` IS NULL
);--> statement-breakpoint
DELETE FROM `mention_deliveries`
WHERE `post_id` IN (
  SELECT `posts`.`id` FROM `posts`
  LEFT JOIN `users` ON `users`.`id` = `posts`.`user_id`
  WHERE `users`.`id` IS NULL
);--> statement-breakpoint
DELETE FROM `posts`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `posts`.`user_id`);--> statement-breakpoint

-- Repair any other historical foreign-key violations, regardless of source.
UPDATE `posts` SET `removed_by` = NULL
WHERE `removed_by` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `posts`.`removed_by`);--> statement-breakpoint
DELETE FROM `stuffbox_connections`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `stuffbox_connections`.`user_id`);--> statement-breakpoint
DELETE FROM `media`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `media`.`user_id`)
   OR (`post_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `posts` WHERE `posts`.`id` = `media`.`post_id`));--> statement-breakpoint
DELETE FROM `follows`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `follows`.`follower_id`)
   OR NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `follows`.`following_id`);--> statement-breakpoint
DELETE FROM `remote_follows`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `remote_follows`.`follower_id`);--> statement-breakpoint
DELETE FROM `remote_followers`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `remote_followers`.`user_id`);--> statement-breakpoint
DELETE FROM `likes`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `likes`.`user_id`)
   OR NOT EXISTS (SELECT 1 FROM `posts` WHERE `posts`.`id` = `likes`.`post_id`);--> statement-breakpoint
DELETE FROM `remote_likes`
WHERE NOT EXISTS (SELECT 1 FROM `posts` WHERE `posts`.`id` = `remote_likes`.`post_id`);--> statement-breakpoint
DELETE FROM `user_swarm_likes`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `user_swarm_likes`.`user_id`);--> statement-breakpoint
DELETE FROM `user_swarm_reposts`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `user_swarm_reposts`.`user_id`);--> statement-breakpoint
DELETE FROM `remote_reposts`
WHERE NOT EXISTS (SELECT 1 FROM `posts` WHERE `posts`.`id` = `remote_reposts`.`post_id`);--> statement-breakpoint
DELETE FROM `notifications`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `notifications`.`user_id`)
   OR (`actor_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `notifications`.`actor_id`))
   OR (`post_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `posts` WHERE `posts`.`id` = `notifications`.`post_id`));--> statement-breakpoint
DELETE FROM `mention_deliveries`
WHERE NOT EXISTS (SELECT 1 FROM `posts` WHERE `posts`.`id` = `mention_deliveries`.`post_id`);--> statement-breakpoint
DELETE FROM `sessions`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `sessions`.`user_id`);--> statement-breakpoint
DELETE FROM `blocks`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `blocks`.`user_id`)
   OR NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `blocks`.`blocked_user_id`);--> statement-breakpoint
DELETE FROM `mutes`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `mutes`.`user_id`)
   OR NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `mutes`.`muted_user_id`);--> statement-breakpoint
DELETE FROM `muted_nodes`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `muted_nodes`.`user_id`);--> statement-breakpoint
UPDATE `reports` SET `reporter_id` = NULL
WHERE `reporter_id` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `reports`.`reporter_id`);--> statement-breakpoint
UPDATE `reports` SET `resolved_by` = NULL
WHERE `resolved_by` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `reports`.`resolved_by`);--> statement-breakpoint
DELETE FROM `chat_conversations`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `chat_conversations`.`participant1_id`);--> statement-breakpoint
DELETE FROM `chat_messages`
WHERE NOT EXISTS (SELECT 1 FROM `chat_conversations` WHERE `chat_conversations`.`id` = `chat_messages`.`conversation_id`);--> statement-breakpoint
DELETE FROM `chat_typing_indicators`
WHERE NOT EXISTS (SELECT 1 FROM `chat_conversations` WHERE `chat_conversations`.`id` = `chat_typing_indicators`.`conversation_id`);--> statement-breakpoint
DELETE FROM `e2ee_key_bundles`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `e2ee_key_bundles`.`user_id`);--> statement-breakpoint
DELETE FROM `e2ee_key_vaults`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `e2ee_key_vaults`.`user_id`);--> statement-breakpoint
DELETE FROM `e2ee_message_receipts`
WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `users`.`id` = `e2ee_message_receipts`.`owner_user_id`);
