UPDATE `users`
SET `nsfw_enabled` = true,
    `updated_at` = unixepoch()
WHERE EXISTS (
    SELECT 1
    FROM `nodes`
    WHERE `nodes`.`is_nsfw` = true
);
