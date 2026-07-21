ALTER TABLE `swarm_nodes` ADD `remote_access_denied_at` integer;
--> statement-breakpoint
ALTER TABLE `swarm_nodes` ADD `remote_access_denied_reason` text;
--> statement-breakpoint
CREATE INDEX `swarm_nodes_remote_denied_idx` ON `swarm_nodes` (`remote_access_denied_at`);
--> statement-breakpoint
ALTER TABLE `user_swarm_reposts` ADD `origin_unavailable_at` integer;
--> statement-breakpoint
DELETE FROM `remote_posts`
WHERE `node_domain` IN (SELECT `domain` FROM `swarm_nodes` WHERE `is_blocked` = 1);
--> statement-breakpoint
DELETE FROM `remote_feed_stories`
WHERE `node_domain` IN (SELECT `domain` FROM `swarm_nodes` WHERE `is_blocked` = 1);
--> statement-breakpoint
DELETE FROM `user_swarm_likes`
WHERE `node_domain` IN (SELECT `domain` FROM `swarm_nodes` WHERE `is_blocked` = 1);
--> statement-breakpoint
UPDATE `user_swarm_reposts`
SET `content` = '',
    `author_display_name` = NULL,
    `author_avatar_url` = NULL,
    `likes_count` = 0,
    `reposts_count` = 0,
    `replies_count` = 0,
    `link_preview_url` = NULL,
    `link_preview_title` = NULL,
    `link_preview_description` = NULL,
    `link_preview_image` = NULL,
    `link_preview_type` = NULL,
    `link_preview_video_url` = NULL,
    `link_preview_media_json` = NULL,
    `media_json` = NULL,
    `origin_unavailable_at` = unixepoch()
WHERE `node_domain` IN (SELECT `domain` FROM `swarm_nodes` WHERE `is_blocked` = 1);
