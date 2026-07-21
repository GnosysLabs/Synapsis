DROP TRIGGER IF EXISTS `swarm_post_changes_users_update`;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_users_update`
AFTER UPDATE OF `handle`, `username`, `home_domain`, `is_local_account`,
  `display_name`, `avatar_url`, `is_nsfw`, `is_suspended`,
  `stuffbox_badge_proof`, `stuffbox_badge_level`, `stuffbox_badge_plan`,
  `stuffbox_badge_issuer`, `stuffbox_badge_expires_at` ON `users`
WHEN (OLD.`is_local_account` = 1 OR NEW.`is_local_account` = 1)
  AND (
    OLD.`handle` IS NOT NEW.`handle`
    OR OLD.`username` IS NOT NEW.`username`
    OR OLD.`home_domain` IS NOT NEW.`home_domain`
    OR OLD.`is_local_account` IS NOT NEW.`is_local_account`
    OR OLD.`display_name` IS NOT NEW.`display_name`
    OR OLD.`avatar_url` IS NOT NEW.`avatar_url`
    OR OLD.`is_nsfw` IS NOT NEW.`is_nsfw`
    OR OLD.`is_suspended` IS NOT NEW.`is_suspended`
    OR OLD.`stuffbox_badge_proof` IS NOT NEW.`stuffbox_badge_proof`
    OR OLD.`stuffbox_badge_level` IS NOT NEW.`stuffbox_badge_level`
    OR OLD.`stuffbox_badge_plan` IS NOT NEW.`stuffbox_badge_plan`
    OR OLD.`stuffbox_badge_issuer` IS NOT NEW.`stuffbox_badge_issuer`
    OR OLD.`stuffbox_badge_expires_at` IS NOT NEW.`stuffbox_badge_expires_at`
  )
BEGIN
  UPDATE `posts` SET `content` = `content`
  WHERE `user_id` = NEW.`id`
    AND `reply_to_id` IS NULL
    AND `swarm_reply_to_id` IS NULL;
END;
--> statement-breakpoint
UPDATE `posts` SET `content` = `content`
WHERE `user_id` IN (
  SELECT `id` FROM `users`
  WHERE `is_local_account` = 1
    AND `stuffbox_badge_proof` IS NOT NULL
)
  AND `reply_to_id` IS NULL
  AND `swarm_reply_to_id` IS NULL;
