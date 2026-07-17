UPDATE `users`
SET `nsfw_enabled` = false,
    `updated_at` = unixepoch()
WHERE `age_verified_at` IS NULL
  AND EXISTS (
      SELECT 1
      FROM `nodes`
      WHERE `nodes`.`is_nsfw` = true
  );
