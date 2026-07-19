ALTER TABLE `swarm_nodes` ADD `content_sequence` integer;
--> statement-breakpoint
ALTER TABLE `handle_registry` ADD `deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `node_domain` text;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `original_post_id` text;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `post_json` text;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `feed_activity_at` integer;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `is_reply` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `is_nsfw` integer;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `author_is_nsfw` integer;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `node_is_nsfw` integer;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `likes_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `reposts_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `remote_posts` ADD `replies_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `remote_posts`
SET
  `node_domain` = substr(`ap_id`, 7, instr(substr(`ap_id`, 7), ':') - 1),
  `original_post_id` = substr(`ap_id`, 7 + instr(substr(`ap_id`, 7), ':')),
  `feed_activity_at` = `published_at`
WHERE `ap_id` LIKE 'swarm:%:%'
  AND `ap_id` NOT LIKE 'swarm://%';
--> statement-breakpoint
UPDATE `remote_posts`
SET
  `node_domain` = substr(`ap_id`, 9, instr(substr(`ap_id`, 9), '/') - 1),
  `original_post_id` = substr(`ap_id`, instr(`ap_id`, '/posts/') + 7),
  `feed_activity_at` = `published_at`
WHERE `ap_id` LIKE 'swarm://%/posts/%';
--> statement-breakpoint
DELETE FROM `remote_posts`
WHERE `node_domain` IS NOT NULL
  AND `original_post_id` IS NOT NULL
  AND rowid NOT IN (
    SELECT max(rowid)
    FROM `remote_posts`
    WHERE `node_domain` IS NOT NULL AND `original_post_id` IS NOT NULL
    GROUP BY `node_domain`, `original_post_id`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_posts_node_post_unique_idx`
  ON `remote_posts` (`node_domain`, `original_post_id`);
--> statement-breakpoint
CREATE INDEX `remote_posts_node_activity_idx`
  ON `remote_posts` (`node_domain`, `feed_activity_at`);
--> statement-breakpoint
CREATE INDEX `remote_posts_author_activity_idx`
  ON `remote_posts` (`author_handle`, `feed_activity_at`);
--> statement-breakpoint
CREATE INDEX `remote_posts_fetched_idx` ON `remote_posts` (`fetched_at`);
--> statement-breakpoint
CREATE TABLE `swarm_content_sync_states` (
  `domain` text PRIMARY KEY NOT NULL REFERENCES `swarm_nodes`(`domain`) ON DELETE CASCADE,
  `failures` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_attempt_at` integer,
  `last_success_at` integer,
  `high_water_at` integer,
  `high_water_id` text,
  `change_cursor` integer,
  `account_change_cursor` integer,
  `legacy_reconcile_cursor` text,
  `legacy_reconcile_complete` integer DEFAULT 0 NOT NULL,
  `lease_owner` text,
  `lease_expires_at` integer,
  `last_error` text,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `swarm_content_sync_due_idx`
  ON `swarm_content_sync_states` (`next_attempt_at`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `swarm_content_sync_success_idx`
  ON `swarm_content_sync_states` (`last_success_at`);
--> statement-breakpoint
CREATE TABLE `remote_follow_sync_states` (
  `target_handle` text PRIMARY KEY NOT NULL,
  `node_domain` text NOT NULL,
  `failures` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_attempt_at` integer,
  `last_success_at` integer,
  `lease_owner` text,
  `lease_expires_at` integer,
  `last_error` text,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `remote_follow_sync_due_idx`
  ON `remote_follow_sync_states` (`next_attempt_at`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `remote_follow_sync_domain_idx`
  ON `remote_follow_sync_states` (`node_domain`);
--> statement-breakpoint
CREATE TABLE `feed_stories` (
  `story_id` text PRIMARY KEY NOT NULL,
  `latest_activity_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `feed_stories_activity_idx`
  ON `feed_stories` (`latest_activity_at`, `story_id`);
--> statement-breakpoint
INSERT INTO `feed_stories` (`story_id`, `latest_activity_at`)
SELECT `story_id`, max(`activity_at`)
FROM (
  SELECT coalesce(`repost_of_id`, `id`) AS `story_id`, `created_at` AS `activity_at`
  FROM `posts`
  WHERE `is_removed` = 0 AND `reply_to_id` IS NULL AND `swarm_reply_to_id` IS NULL
  UNION ALL
  SELECT `post_id` AS `story_id`, `created_at` AS `activity_at` FROM `remote_reposts`
)
GROUP BY `story_id`;
--> statement-breakpoint
CREATE TRIGGER `feed_stories_posts_insert`
AFTER INSERT ON `posts`
WHEN NEW.`is_removed` = 0 AND NEW.`reply_to_id` IS NULL AND NEW.`swarm_reply_to_id` IS NULL
BEGIN
  INSERT INTO `feed_stories` (`story_id`, `latest_activity_at`)
  VALUES (coalesce(NEW.`repost_of_id`, NEW.`id`), NEW.`created_at`)
  ON CONFLICT (`story_id`) DO UPDATE SET
    `latest_activity_at` = max(`latest_activity_at`, excluded.`latest_activity_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `feed_stories_posts_delete`
AFTER DELETE ON `posts`
BEGIN
  UPDATE `feed_stories`
  SET `latest_activity_at` = coalesce((
    SELECT max(`activity_at`) FROM (
      SELECT `created_at` AS `activity_at` FROM `posts`
      WHERE coalesce(`repost_of_id`, `id`) = coalesce(OLD.`repost_of_id`, OLD.`id`)
        AND `is_removed` = 0 AND `reply_to_id` IS NULL AND `swarm_reply_to_id` IS NULL
      UNION ALL
      SELECT `created_at` FROM `remote_reposts`
      WHERE `post_id` = coalesce(OLD.`repost_of_id`, OLD.`id`)
    )
  ), 0)
  WHERE `story_id` = coalesce(OLD.`repost_of_id`, OLD.`id`);
  DELETE FROM `feed_stories` WHERE `latest_activity_at` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER `feed_stories_posts_update`
AFTER UPDATE OF `repost_of_id`, `is_removed`, `reply_to_id`, `swarm_reply_to_id`, `created_at` ON `posts`
BEGIN
  UPDATE `feed_stories`
  SET `latest_activity_at` = coalesce((
    SELECT max(`activity_at`) FROM (
      SELECT `created_at` AS `activity_at` FROM `posts`
      WHERE coalesce(`repost_of_id`, `id`) = coalesce(OLD.`repost_of_id`, OLD.`id`)
        AND `is_removed` = 0 AND `reply_to_id` IS NULL AND `swarm_reply_to_id` IS NULL
      UNION ALL
      SELECT `created_at` FROM `remote_reposts`
      WHERE `post_id` = coalesce(OLD.`repost_of_id`, OLD.`id`)
    )
  ), 0)
  WHERE `story_id` = coalesce(OLD.`repost_of_id`, OLD.`id`);
  DELETE FROM `feed_stories` WHERE `latest_activity_at` = 0;
  INSERT INTO `feed_stories` (`story_id`, `latest_activity_at`)
  SELECT coalesce(NEW.`repost_of_id`, NEW.`id`), NEW.`created_at`
  WHERE NEW.`is_removed` = 0 AND NEW.`reply_to_id` IS NULL AND NEW.`swarm_reply_to_id` IS NULL
  ON CONFLICT (`story_id`) DO UPDATE SET
    `latest_activity_at` = max(`latest_activity_at`, excluded.`latest_activity_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `feed_stories_remote_reposts_insert`
AFTER INSERT ON `remote_reposts`
BEGIN
  INSERT INTO `feed_stories` (`story_id`, `latest_activity_at`)
  VALUES (NEW.`post_id`, NEW.`created_at`)
  ON CONFLICT (`story_id`) DO UPDATE SET
    `latest_activity_at` = max(`latest_activity_at`, excluded.`latest_activity_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `feed_stories_remote_reposts_delete`
AFTER DELETE ON `remote_reposts`
BEGIN
  UPDATE `feed_stories`
  SET `latest_activity_at` = coalesce((
    SELECT max(`activity_at`) FROM (
      SELECT `created_at` AS `activity_at` FROM `posts`
      WHERE coalesce(`repost_of_id`, `id`) = OLD.`post_id`
        AND `is_removed` = 0 AND `reply_to_id` IS NULL AND `swarm_reply_to_id` IS NULL
      UNION ALL
      SELECT `created_at` FROM `remote_reposts` WHERE `post_id` = OLD.`post_id`
    )
  ), 0)
  WHERE `story_id` = OLD.`post_id`;
  DELETE FROM `feed_stories` WHERE `latest_activity_at` = 0;
END;
--> statement-breakpoint
CREATE TABLE `remote_feed_stories` (
  `node_domain` text NOT NULL,
  `original_post_id` text NOT NULL,
  `latest_activity_at` integer NOT NULL,
  PRIMARY KEY (`node_domain`, `original_post_id`)
);
--> statement-breakpoint
CREATE INDEX `remote_feed_stories_activity_idx`
  ON `remote_feed_stories` (`latest_activity_at`, `node_domain`, `original_post_id`);
--> statement-breakpoint
INSERT INTO `remote_feed_stories` (`node_domain`, `original_post_id`, `latest_activity_at`)
SELECT `node_domain`, `original_post_id`, max(`reposted_at`)
FROM `user_swarm_reposts`
GROUP BY `node_domain`, `original_post_id`;
--> statement-breakpoint
CREATE TRIGGER `remote_feed_stories_insert`
AFTER INSERT ON `user_swarm_reposts`
BEGIN
  INSERT INTO `remote_feed_stories` (`node_domain`, `original_post_id`, `latest_activity_at`)
  VALUES (NEW.`node_domain`, NEW.`original_post_id`, NEW.`reposted_at`)
  ON CONFLICT (`node_domain`, `original_post_id`) DO UPDATE SET
    `latest_activity_at` = max(`latest_activity_at`, excluded.`latest_activity_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `remote_feed_stories_delete`
AFTER DELETE ON `user_swarm_reposts`
BEGIN
  UPDATE `remote_feed_stories`
  SET `latest_activity_at` = coalesce((
    SELECT max(`reposted_at`) FROM `user_swarm_reposts`
    WHERE `node_domain` = OLD.`node_domain` AND `original_post_id` = OLD.`original_post_id`
  ), 0)
  WHERE `node_domain` = OLD.`node_domain` AND `original_post_id` = OLD.`original_post_id`;
  DELETE FROM `remote_feed_stories` WHERE `latest_activity_at` = 0;
END;
--> statement-breakpoint
DELETE FROM `follows` WHERE rowid NOT IN (
  SELECT min(rowid) FROM `follows` GROUP BY `follower_id`, `following_id`
);
--> statement-breakpoint
DELETE FROM `remote_follows` WHERE rowid NOT IN (
  SELECT min(rowid) FROM `remote_follows` GROUP BY `follower_id`, lower(`target_handle`)
);
--> statement-breakpoint
UPDATE `remote_follows` SET `target_handle` = lower(`target_handle`);
--> statement-breakpoint
DELETE FROM `likes` WHERE rowid NOT IN (
  SELECT min(rowid) FROM `likes` GROUP BY `user_id`, `post_id`
);
--> statement-breakpoint
DELETE FROM `blocks` WHERE rowid NOT IN (
  SELECT min(rowid) FROM `blocks` GROUP BY `user_id`, `blocked_user_id`
);
--> statement-breakpoint
DELETE FROM `mutes` WHERE rowid NOT IN (
  SELECT min(rowid) FROM `mutes` GROUP BY `user_id`, `muted_user_id`
);
--> statement-breakpoint
UPDATE `muted_nodes` SET `node_domain` = lower(`node_domain`);
--> statement-breakpoint
DELETE FROM `muted_nodes` WHERE rowid NOT IN (
  SELECT min(rowid) FROM `muted_nodes` GROUP BY `user_id`, `node_domain`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follows_user_pair_unique_idx` ON `follows` (`follower_id`, `following_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_follows_user_target_unique_idx` ON `remote_follows` (`follower_id`, `target_handle`);
--> statement-breakpoint
CREATE UNIQUE INDEX `likes_user_post_unique_idx` ON `likes` (`user_id`, `post_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_user_target_unique_idx` ON `blocks` (`user_id`, `blocked_user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mutes_user_target_unique_idx` ON `mutes` (`user_id`, `muted_user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `muted_nodes_user_domain_unique_idx` ON `muted_nodes` (`user_id`, `node_domain`);
--> statement-breakpoint
CREATE INDEX `posts_user_created_idx` ON `posts` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `posts_feed_filter_idx` ON `posts` (`is_removed`, `reply_to_id`, `swarm_reply_to_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `notifications_user_read_created_idx` ON `notifications` (`user_id`, `read_at`, `created_at`);
--> statement-breakpoint
CREATE INDEX `swarm_nodes_eligible_seen_idx` ON `swarm_nodes` (`is_active`, `is_blocked`, `trust_score`, `last_seen_at`);
--> statement-breakpoint
CREATE INDEX `chat_conversations_participant_activity_idx` ON `chat_conversations` (`participant1_id`, `last_message_at`);
--> statement-breakpoint
CREATE INDEX `chat_messages_conversation_created_idx` ON `chat_messages` (`conversation_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `local_post_search_terms` (
  `post_id` text NOT NULL REFERENCES `posts`(`id`) ON DELETE CASCADE,
  `term` text NOT NULL,
  PRIMARY KEY (`post_id`, `term`)
);
--> statement-breakpoint
CREATE INDEX `local_post_search_terms_term_idx` ON `local_post_search_terms` (`term`, `post_id`);
--> statement-breakpoint
CREATE TABLE `remote_post_search_terms` (
  `post_id` text NOT NULL REFERENCES `remote_posts`(`id`) ON DELETE CASCADE,
  `term` text NOT NULL,
  PRIMARY KEY (`post_id`, `term`)
);
--> statement-breakpoint
CREATE INDEX `remote_post_search_terms_term_idx` ON `remote_post_search_terms` (`term`, `post_id`);
--> statement-breakpoint
CREATE TABLE `swarm_content_clock` (
  `id` integer PRIMARY KEY NOT NULL,
  `sequence` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `swarm_content_clock` (`id`, `sequence`) VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE `swarm_post_changes` (
  `story_id` text PRIMARY KEY NOT NULL,
  `sequence` integer NOT NULL,
  `change_type` text NOT NULL,
  `changed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_post_changes_sequence_idx` ON `swarm_post_changes` (`sequence`);
--> statement-breakpoint
CREATE INDEX `swarm_post_changes_changed_idx` ON `swarm_post_changes` (`changed_at`);
--> statement-breakpoint
CREATE TABLE `swarm_account_tombstones` (
  `handle` text PRIMARY KEY NOT NULL,
  `did` text NOT NULL,
  `sequence` integer NOT NULL,
  `deleted_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_account_tombstones_sequence_idx`
  ON `swarm_account_tombstones` (`sequence`);
--> statement-breakpoint
CREATE INDEX `swarm_account_tombstones_deleted_idx`
  ON `swarm_account_tombstones` (`deleted_at`);
--> statement-breakpoint
INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
SELECT `story_id`, rowid, 'upsert', `latest_activity_at` FROM `feed_stories`;
--> statement-breakpoint
UPDATE `swarm_content_clock`
SET `sequence` = coalesce((SELECT max(`sequence`) FROM `swarm_post_changes`), 0)
WHERE `id` = 1;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_posts_insert`
AFTER INSERT ON `posts`
WHEN NEW.`is_removed` = 0
  AND NEW.`reply_to_id` IS NULL
  AND NEW.`swarm_reply_to_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` = NEW.`user_id` AND `node_id` IS NULL AND `handle` NOT LIKE '%@%'
      AND `is_suspended` = 0
  )
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(NEW.`repost_of_id`, NEW.`id`), `sequence`, 'upsert', unixepoch()
  FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_posts_delete`
BEFORE DELETE ON `posts`
WHEN OLD.`reply_to_id` IS NULL
  AND OLD.`swarm_reply_to_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` = OLD.`user_id` AND `node_id` IS NULL AND `handle` NOT LIKE '%@%'
  )
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(OLD.`repost_of_id`, OLD.`id`), `sequence`,
    CASE WHEN OLD.`repost_of_id` IS NULL THEN 'delete' ELSE 'upsert' END,
    unixepoch()
  FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_posts_update`
AFTER UPDATE OF `content`, `repost_of_id`, `likes_count`, `reposts_count`, `replies_count`,
  `is_nsfw`, `is_removed`, `link_preview_url`, `link_preview_title`,
  `link_preview_description`, `link_preview_image`, `link_preview_type`,
  `link_preview_video_url`, `link_preview_media_json` ON `posts`
WHEN OLD.`reply_to_id` IS NULL AND OLD.`swarm_reply_to_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` = OLD.`user_id` AND `node_id` IS NULL AND `handle` NOT LIKE '%@%'
  )
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(OLD.`repost_of_id`, OLD.`id`), `sequence`,
    CASE WHEN EXISTS (
      SELECT 1 FROM `posts` AS `origin`
      INNER JOIN `users` AS `author` ON `author`.`id` = `origin`.`user_id`
      WHERE `origin`.`id` = coalesce(OLD.`repost_of_id`, OLD.`id`)
        AND `origin`.`is_removed` = 0
        AND `origin`.`reply_to_id` IS NULL
        AND `origin`.`swarm_reply_to_id` IS NULL
        AND `author`.`node_id` IS NULL
        AND `author`.`handle` NOT LIKE '%@%'
        AND `author`.`is_suspended` = 0
    ) THEN 'upsert' ELSE 'delete' END,
    unixepoch()
  FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;

  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1
  WHERE `id` = 1 AND coalesce(NEW.`repost_of_id`, NEW.`id`) <> coalesce(OLD.`repost_of_id`, OLD.`id`);
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(NEW.`repost_of_id`, NEW.`id`), `sequence`,
    CASE WHEN EXISTS (
      SELECT 1 FROM `posts` AS `origin`
      INNER JOIN `users` AS `author` ON `author`.`id` = `origin`.`user_id`
      WHERE `origin`.`id` = coalesce(NEW.`repost_of_id`, NEW.`id`)
        AND `origin`.`is_removed` = 0
        AND `origin`.`reply_to_id` IS NULL
        AND `origin`.`swarm_reply_to_id` IS NULL
        AND `author`.`node_id` IS NULL
        AND `author`.`handle` NOT LIKE '%@%'
        AND `author`.`is_suspended` = 0
    ) THEN 'upsert' ELSE 'delete' END,
    unixepoch()
  FROM `swarm_content_clock`
  WHERE `id` = 1 AND coalesce(NEW.`repost_of_id`, NEW.`id`) <> coalesce(OLD.`repost_of_id`, OLD.`id`)
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_users_update`
AFTER UPDATE OF `handle`, `display_name`, `avatar_url`, `is_nsfw`, `is_suspended` ON `users`
WHEN NEW.`node_id` IS NULL AND NEW.`handle` NOT LIKE '%@%'
  AND (
    OLD.`handle` IS NOT NEW.`handle`
    OR OLD.`display_name` IS NOT NEW.`display_name`
    OR OLD.`avatar_url` IS NOT NEW.`avatar_url`
    OR OLD.`is_nsfw` IS NOT NEW.`is_nsfw`
    OR OLD.`is_suspended` IS NOT NEW.`is_suspended`
  )
BEGIN
  -- Updating a listed column to itself deliberately invokes the per-post
  -- change trigger once per story, giving every card its own sequence number.
  UPDATE `posts` SET `content` = `content`
  WHERE `user_id` = NEW.`id`
    AND `reply_to_id` IS NULL
    AND `swarm_reply_to_id` IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_media_insert`
AFTER INSERT ON `media`
WHEN NEW.`post_id` IS NOT NULL
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = NEW.`post_id` AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`node_id` IS NULL AND `author`.`handle` NOT LIKE '%@%'
    AND `author`.`is_suspended` = 0
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_media_delete`
AFTER DELETE ON `media`
WHEN OLD.`post_id` IS NOT NULL
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = OLD.`post_id` AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`node_id` IS NULL AND `author`.`handle` NOT LIKE '%@%'
    AND `author`.`is_suspended` = 0
    AND `author`.`is_suspended` = 0
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_media_update`
AFTER UPDATE OF `post_id`, `url`, `alt_text`, `mime_type`, `width`, `height` ON `media`
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = OLD.`post_id` AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`node_id` IS NULL AND `author`.`handle` NOT LIKE '%@%'
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;

  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1
  WHERE `id` = 1 AND NEW.`post_id` IS NOT OLD.`post_id`;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = NEW.`post_id` AND NEW.`post_id` IS NOT OLD.`post_id`
    AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`node_id` IS NULL AND `author`.`handle` NOT LIKE '%@%'
    AND `author`.`is_suspended` = 0
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_remote_reposts_insert`
AFTER INSERT ON `remote_reposts`
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT NEW.`post_id`, `sequence`, 'upsert', unixepoch() FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_remote_reposts_delete`
AFTER DELETE ON `remote_reposts`
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT OLD.`post_id`, `sequence`, 'upsert', unixepoch() FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
