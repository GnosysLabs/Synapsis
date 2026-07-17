ALTER TABLE `nodes` ADD `nsfw_activated_at` integer;
--> statement-breakpoint
-- Adult-only nodes that predate activation tracking already required an 18+
-- checkbox in their registration UI. Treat their creation as the legacy
-- activation boundary, then restore only local password accounts created on or
-- after that boundary. Remote cache rows are deliberately excluded.
UPDATE `nodes`
SET `nsfw_activated_at` = `created_at`
WHERE `is_nsfw` = true
  AND `nsfw_activated_at` IS NULL;
--> statement-breakpoint
UPDATE `users`
SET `age_verified_at` = `created_at`,
    `nsfw_enabled` = true,
    `updated_at` = unixepoch()
WHERE `age_verified_at` IS NULL
  AND `password_hash` IS NOT NULL
  AND `email` IS NOT NULL
  AND `handle` NOT LIKE '%@%'
  AND EXISTS (
      SELECT 1
      FROM `nodes`
      WHERE `nodes`.`is_nsfw` = true
        AND `nodes`.`nsfw_activated_at` IS NOT NULL
        AND `users`.`created_at` >= `nodes`.`nsfw_activated_at`
  );
