-- A node block is an administrative federation quarantine, not a transient
-- network error. Give both directions of the remote social graph explicit
-- domain ownership and a reversible-but-inactive suspension state.

ALTER TABLE `swarm_nodes` ADD COLUMN `quarantine_completed_at` integer;
--> statement-breakpoint
ALTER TABLE `swarm_nodes` ADD COLUMN `quarantine_error` text;
--> statement-breakpoint
CREATE INDEX `swarm_nodes_block_quarantine_idx`
  ON `swarm_nodes` (`is_blocked`, `quarantine_completed_at`);
--> statement-breakpoint

CREATE TABLE `__node_block_remote_follows` (
  `id` text PRIMARY KEY,
  `follower_id` text NOT NULL,
  `target_handle` text NOT NULL,
  `target_node_domain` text NOT NULL,
  `target_actor_url` text NOT NULL,
  `inbox_url` text NOT NULL,
  `activity_id` text NOT NULL,
  `display_name` text,
  `bio` text,
  `avatar_url` text,
  `suspended_at` integer,
  `suspension_reason` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CHECK (`target_handle` = lower(`target_handle`)),
  CHECK (`target_node_domain` = lower(`target_node_domain`)),
  CHECK (`target_handle` LIKE '%@' || `target_node_domain`),
  CHECK (instr(`target_node_domain`, '@') = 0),
  CHECK (instr(`target_node_domain`, '/') = 0)
);
--> statement-breakpoint
INSERT INTO `__node_block_remote_follows` (
  `id`, `follower_id`, `target_handle`, `target_node_domain`,
  `target_actor_url`, `inbox_url`, `activity_id`, `display_name`, `bio`,
  `avatar_url`, `suspended_at`, `suspension_reason`, `created_at`
)
SELECT
  `follow`.`id`,
  `follow`.`follower_id`,
  `follow`.`target_handle`,
  substr(`follow`.`target_handle`, instr(`follow`.`target_handle`, '@') + 1),
  `follow`.`target_actor_url`,
  `follow`.`inbox_url`,
  `follow`.`activity_id`,
  `follow`.`display_name`,
  `follow`.`bio`,
  `follow`.`avatar_url`,
  CASE WHEN `node`.`is_blocked` = 1
    THEN coalesce(`node`.`blocked_at`, unixepoch()) ELSE NULL END,
  CASE WHEN `node`.`is_blocked` = 1 THEN 'node_block' ELSE NULL END,
  `follow`.`created_at`
FROM `remote_follows` AS `follow`
LEFT JOIN `swarm_nodes` AS `node`
  ON `node`.`domain` = substr(`follow`.`target_handle`, instr(`follow`.`target_handle`, '@') + 1);
--> statement-breakpoint
DROP TABLE `remote_follows`;
--> statement-breakpoint
ALTER TABLE `__node_block_remote_follows` RENAME TO `remote_follows`;
--> statement-breakpoint
CREATE INDEX `remote_follows_follower_idx` ON `remote_follows` (`follower_id`);
--> statement-breakpoint
CREATE INDEX `remote_follows_target_idx` ON `remote_follows` (`target_handle`);
--> statement-breakpoint
CREATE INDEX `remote_follows_domain_active_idx`
  ON `remote_follows` (`target_node_domain`, `suspended_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_follows_user_target_unique_idx`
  ON `remote_follows` (`follower_id`, `target_handle`);
--> statement-breakpoint

-- Some legacy follower rows predate canonical presentation handles. Their
-- exact-origin actor URL is sufficient for a moderation boundary, but never
-- replaces handle/DID continuity as identity authority.
CREATE TEMP TABLE `__node_block_remote_follower_domains` (
  `id` text PRIMARY KEY,
  `domain` text NOT NULL,
  CHECK (`domain` = lower(`domain`)),
  CHECK (length(`domain`) > 0),
  CHECK (instr(`domain`, '@') = 0),
  CHECK (instr(`domain`, '/') = 0)
);
--> statement-breakpoint
INSERT INTO `__node_block_remote_follower_domains` (`id`, `domain`)
SELECT
  `id`,
  replace(lower(CASE
    WHEN `handle` IS NOT NULL AND instr(`handle`, '@') > 1
      THEN substr(`handle`, instr(`handle`, '@') + 1)
    WHEN lower(`actor_url`) LIKE 'swarm://%/%'
      THEN substr(`actor_url`, 9, instr(substr(`actor_url`, 9), '/') - 1)
    WHEN lower(`actor_url`) LIKE 'https://%/%'
      THEN substr(`actor_url`, 9, instr(substr(`actor_url`, 9), '/') - 1)
    WHEN lower(`actor_url`) LIKE 'http://%/%'
      THEN substr(`actor_url`, 8, instr(substr(`actor_url`, 8), '/') - 1)
    ELSE NULL
  END), 'node.synapsis.social', 'synapsis.social')
FROM `remote_followers`;
--> statement-breakpoint

CREATE TEMP TABLE `__node_block_guard` (`ok` integer NOT NULL CHECK (`ok` = 1));
--> statement-breakpoint
INSERT INTO `__node_block_guard` (`ok`)
SELECT CASE WHEN
  (SELECT count(*) FROM `__node_block_remote_follower_domains`)
    = (SELECT count(*) FROM `remote_followers`)
  THEN 1 ELSE 0 END;
--> statement-breakpoint

CREATE TABLE `__node_block_remote_followers` (
  `id` text PRIMARY KEY,
  `user_id` text NOT NULL,
  `actor_url` text NOT NULL,
  `actor_node_domain` text NOT NULL,
  `inbox_url` text NOT NULL,
  `shared_inbox_url` text,
  `handle` text,
  `activity_id` text,
  `suspended_at` integer,
  `suspension_reason` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CHECK (`actor_node_domain` = lower(`actor_node_domain`)),
  CHECK (`handle` IS NULL OR `handle` LIKE '%@' || `actor_node_domain`),
  CHECK (instr(`actor_node_domain`, '@') = 0),
  CHECK (instr(`actor_node_domain`, '/') = 0)
);
--> statement-breakpoint
INSERT INTO `__node_block_remote_followers` (
  `id`, `user_id`, `actor_url`, `actor_node_domain`, `inbox_url`,
  `shared_inbox_url`, `handle`, `activity_id`, `suspended_at`,
  `suspension_reason`, `created_at`
)
SELECT
  `follower`.`id`,
  `follower`.`user_id`,
  `follower`.`actor_url`,
  `plan`.`domain`,
  `follower`.`inbox_url`,
  `follower`.`shared_inbox_url`,
  `follower`.`handle`,
  `follower`.`activity_id`,
  CASE WHEN `node`.`is_blocked` = 1
    THEN coalesce(`node`.`blocked_at`, unixepoch()) ELSE NULL END,
  CASE WHEN `node`.`is_blocked` = 1 THEN 'node_block' ELSE NULL END,
  `follower`.`created_at`
FROM `remote_followers` AS `follower`
INNER JOIN `__node_block_remote_follower_domains` AS `plan`
  ON `plan`.`id` = `follower`.`id`
LEFT JOIN `swarm_nodes` AS `node` ON `node`.`domain` = `plan`.`domain`;
--> statement-breakpoint
DROP TABLE `remote_followers`;
--> statement-breakpoint
ALTER TABLE `__node_block_remote_followers` RENAME TO `remote_followers`;
--> statement-breakpoint
CREATE INDEX `remote_followers_user_idx` ON `remote_followers` (`user_id`);
--> statement-breakpoint
CREATE INDEX `remote_followers_actor_idx` ON `remote_followers` (`actor_url`);
--> statement-breakpoint
CREATE INDEX `remote_followers_domain_active_idx`
  ON `remote_followers` (`actor_node_domain`, `suspended_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_followers_user_actor_unique`
  ON `remote_followers` (`user_id`, `actor_url`);
--> statement-breakpoint

-- Bulk quarantine paths must stay indexed as the network grows.
CREATE INDEX `users_remote_home_idx` ON `users` (`home_domain`, `is_local_account`);
--> statement-breakpoint
CREATE INDEX `posts_swarm_reply_idx` ON `posts` (`swarm_reply_to_id`);
--> statement-breakpoint
CREATE INDEX `remote_likes_domain_idx` ON `remote_likes` (`actor_node_domain`);
--> statement-breakpoint
CREATE INDEX `remote_reposts_domain_idx` ON `remote_reposts` (`actor_node_domain`);
--> statement-breakpoint
CREATE INDEX `notifications_actor_domain_idx` ON `notifications` (`actor_node_domain`);
--> statement-breakpoint
CREATE INDEX `notifications_remote_post_domain_idx` ON `notifications` (`remote_post_domain`);
--> statement-breakpoint
CREATE INDEX `mention_deliveries_domain_status_idx`
  ON `mention_deliveries` (`target_domain`, `status`);
--> statement-breakpoint
CREATE INDEX `chat_messages_sender_domain_idx` ON `chat_messages` (`sender_node_domain`);
--> statement-breakpoint

-- Active counters exclude node-block-suspended relationships. Recomputing
-- from materialized truth also repairs any historical counter drift.
UPDATE `users`
SET
  `following_count` =
    (SELECT count(*) FROM `follows` WHERE `follows`.`follower_id` = `users`.`id`)
    + (SELECT count(*) FROM `remote_follows`
       WHERE `remote_follows`.`follower_id` = `users`.`id`
         AND `remote_follows`.`suspended_at` IS NULL),
  `followers_count` =
    (SELECT count(*) FROM `follows` WHERE `follows`.`following_id` = `users`.`id`)
    + (SELECT count(*) FROM `remote_followers`
       WHERE `remote_followers`.`user_id` = `users`.`id`
         AND `remote_followers`.`suspended_at` IS NULL);
--> statement-breakpoint

-- Close follow-vs-block races at the database boundary. Security ledgers and
-- suspended audit rows remain writable; only active projections are refused.
CREATE TRIGGER `remote_follows_blocked_domain_insert`
BEFORE INSERT ON `remote_follows`
WHEN NEW.`suspended_at` IS NULL AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`target_node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot activate a follow for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_follows_blocked_domain_update`
BEFORE UPDATE ON `remote_follows`
WHEN NEW.`suspended_at` IS NULL AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`target_node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reactivate a follow for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_followers_blocked_domain_insert`
BEFORE INSERT ON `remote_followers`
WHEN NEW.`suspended_at` IS NULL AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`actor_node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot activate a follower from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_followers_blocked_domain_update`
BEFORE UPDATE ON `remote_followers`
WHEN NEW.`suspended_at` IS NULL AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`actor_node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reactivate a follower from a blocked node');
END;
--> statement-breakpoint

-- The perimeter flag is committed before cleanup. These guards close the
-- small window in which a request verified just before the block could
-- otherwise recreate a live projection after the flag became durable.
CREATE TRIGGER `remote_likes_blocked_domain_insert`
BEFORE INSERT ON `remote_likes`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`actor_node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot add a like from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_reposts_blocked_domain_insert`
BEFORE INSERT ON `remote_reposts`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`actor_node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot add a repost from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `notifications_blocked_domain_insert`
BEFORE INSERT ON `notifications`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE (`domain` = NEW.`actor_node_domain` OR `domain` = NEW.`remote_post_domain`)
    AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot add a notification involving a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `posts_blocked_remote_author_insert`
BEFORE INSERT ON `posts`
WHEN EXISTS (
  SELECT 1
  FROM `users` AS `author`
  INNER JOIN `swarm_nodes` AS `node` ON `node`.`domain` = `author`.`home_domain`
  WHERE `author`.`id` = NEW.`user_id`
    AND `author`.`is_local_account` = 0
    AND `node`.`is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot add a post from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `posts_blocked_swarm_parent_insert`
BEFORE INSERT ON `posts`
WHEN NEW.`swarm_reply_to_id` IS NOT NULL AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `is_blocked` = 1
    AND NEW.`swarm_reply_to_id` LIKE 'swarm:' || `domain` || ':%'
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reply to a post on a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `posts_blocked_remote_projection_update`
BEFORE UPDATE OF `user_id`, `swarm_reply_to_id` ON `posts`
WHEN EXISTS (
  SELECT 1
  FROM `users` AS `author`
  INNER JOIN `swarm_nodes` AS `node` ON `node`.`domain` = `author`.`home_domain`
  WHERE `author`.`id` = NEW.`user_id`
    AND `author`.`is_local_account` = 0
    AND `node`.`is_blocked` = 1
)
OR (
  NEW.`swarm_reply_to_id` IS NOT NULL AND EXISTS (
    SELECT 1 FROM `swarm_nodes`
    WHERE `is_blocked` = 1
      AND NEW.`swarm_reply_to_id` LIKE 'swarm:' || `domain` || ':%'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'cannot attach a post to a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_posts_blocked_domain_insert`
BEFORE INSERT ON `remote_posts`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot cache a post from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_posts_blocked_domain_update`
BEFORE UPDATE ON `remote_posts`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot refresh a post from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_feed_stories_blocked_domain_insert`
BEFORE INSERT ON `remote_feed_stories`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot cache a feed story from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_feed_stories_blocked_domain_update`
BEFORE UPDATE ON `remote_feed_stories`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot refresh a feed story from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `user_swarm_likes_blocked_domain_insert`
BEFORE INSERT ON `user_swarm_likes`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot like a post on a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `user_swarm_reposts_blocked_domain_insert`
BEFORE INSERT ON `user_swarm_reposts`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot repost a post from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `user_swarm_reposts_blocked_domain_update`
BEFORE UPDATE ON `user_swarm_reposts`
WHEN (
  NEW.`content` <> '' OR NEW.`author_display_name` IS NOT NULL
  OR NEW.`author_avatar_url` IS NOT NULL OR NEW.`likes_count` <> 0
  OR NEW.`reposts_count` <> 0 OR NEW.`replies_count` <> 0
  OR NEW.`link_preview_url` IS NOT NULL OR NEW.`link_preview_title` IS NOT NULL
  OR NEW.`link_preview_description` IS NOT NULL OR NEW.`link_preview_image` IS NOT NULL
  OR NEW.`link_preview_type` IS NOT NULL OR NEW.`link_preview_video_url` IS NOT NULL
  OR NEW.`link_preview_media_json` IS NOT NULL OR NEW.`media_json` IS NOT NULL
)
AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot refresh a repost from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `mention_deliveries_blocked_domain_insert`
BEFORE INSERT ON `mention_deliveries`
WHEN NEW.`status` IN ('pending', 'processing', 'retry') AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`target_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot queue a mention for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `mention_deliveries_blocked_domain_update`
BEFORE UPDATE ON `mention_deliveries`
WHEN NEW.`status` IN ('pending', 'processing', 'retry') AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`target_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reactivate a mention for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_blocked_sender_insert`
BEFORE INSERT ON `chat_messages`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`sender_node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot add a message from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_change_notices_blocked_origin_insert`
BEFORE INSERT ON `swarm_change_notice_states`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`origin_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot queue a change notice for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_change_notices_blocked_origin_update`
BEFORE UPDATE ON `swarm_change_notice_states`
WHEN NEW.`status` IN ('pending', 'processing', 'retry') AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`origin_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot reactivate a change notice for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_change_bundles_blocked_origin_insert`
BEFORE INSERT ON `swarm_change_bundles`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`origin_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot cache a change bundle for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_content_sync_blocked_domain_insert`
BEFORE INSERT ON `swarm_content_sync_states`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot schedule content sync for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_follow_sync_blocked_domain_insert`
BEFORE INSERT ON `remote_follow_sync_states`
WHEN EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`node_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot schedule follow sync for a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_profiles_blocked_home_insert`
BEFORE INSERT ON `users`
WHEN NEW.`is_local_account` = 0 AND EXISTS (
  SELECT 1 FROM `swarm_nodes`
  WHERE `domain` = NEW.`home_domain` AND `is_blocked` = 1
)
BEGIN
  SELECT RAISE(ABORT, 'cannot cache a profile from a blocked node');
END;
--> statement-breakpoint
CREATE TRIGGER `remote_profiles_blocked_mutable_update`
BEFORE UPDATE OF `display_name`, `bio`, `avatar_url`, `header_url`, `website`,
  `followers_count`, `following_count`, `posts_count` ON `users`
WHEN NEW.`is_local_account` = 0
  AND (
    NEW.`display_name` IS NOT NULL OR NEW.`bio` IS NOT NULL
    OR NEW.`avatar_url` IS NOT NULL OR NEW.`header_url` IS NOT NULL
    OR NEW.`website` IS NOT NULL OR NEW.`followers_count` <> 0
    OR NEW.`following_count` <> 0 OR NEW.`posts_count` <> 0
  )
  AND EXISTS (
    SELECT 1 FROM `swarm_nodes`
    WHERE `domain` = NEW.`home_domain` AND `is_blocked` = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'cannot refresh a profile from a blocked node');
END;
--> statement-breakpoint

DROP TABLE `__node_block_guard`;
--> statement-breakpoint
DROP TABLE `__node_block_remote_follower_domains`;
