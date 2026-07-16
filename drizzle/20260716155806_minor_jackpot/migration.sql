ALTER TABLE `remote_reposts` ADD `actor_display_name` text;--> statement-breakpoint
ALTER TABLE `remote_reposts` ADD `actor_avatar_url` text;--> statement-breakpoint
ALTER TABLE `remote_reposts` ADD `actor_is_nsfw` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `remote_reposts`
SET `actor_display_name` = COALESCE((
  SELECT `notifications`.`actor_display_name`
  FROM `notifications`
  WHERE `notifications`.`type` = 'repost'
    AND `notifications`.`post_id` = `remote_reposts`.`post_id`
    AND `notifications`.`actor_handle` = `remote_reposts`.`actor_handle`
    AND `notifications`.`actor_node_domain` = `remote_reposts`.`actor_node_domain`
  ORDER BY `notifications`.`created_at` DESC
  LIMIT 1
), `remote_reposts`.`actor_handle`),
`actor_avatar_url` = (
  SELECT `notifications`.`actor_avatar_url`
  FROM `notifications`
  WHERE `notifications`.`type` = 'repost'
    AND `notifications`.`post_id` = `remote_reposts`.`post_id`
    AND `notifications`.`actor_handle` = `remote_reposts`.`actor_handle`
    AND `notifications`.`actor_node_domain` = `remote_reposts`.`actor_node_domain`
  ORDER BY `notifications`.`created_at` DESC
  LIMIT 1
);
