CREATE TABLE `mention_deliveries` (
	`id` text PRIMARY KEY,
	`interaction_id` text NOT NULL UNIQUE,
	`post_id` text NOT NULL,
	`target_handle` text NOT NULL,
	`target_domain` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_attempt_at` integer,
	`delivered_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `fk_mention_deliveries_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `remote_post_id` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `remote_post_domain` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `interaction_id` text;--> statement-breakpoint
DELETE FROM `bot_mentions`
WHERE `id` IN (
	SELECT `id` FROM (
		SELECT
			`id`,
			ROW_NUMBER() OVER (
				PARTITION BY `bot_id`, `post_id`
				ORDER BY `is_processed` DESC, `created_at` ASC, `id` ASC
			) AS `duplicate_rank`
		FROM `bot_mentions`
	)
	WHERE `duplicate_rank` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `bot_mentions_bot_post_unique_idx` ON `bot_mentions` (`bot_id`,`post_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mention_deliveries_target_unique_idx` ON `mention_deliveries` (`post_id`,`target_handle`,`target_domain`);--> statement-breakpoint
CREATE INDEX `mention_deliveries_due_idx` ON `mention_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_interaction_unique_idx` ON `notifications` (`interaction_id`);
