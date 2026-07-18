CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`relay_subscription_id` text NOT NULL,
	`relay_delivery_token_encrypted` text NOT NULL,
	`environment` text NOT NULL CHECK (`environment` IN ('sandbox', 'production')),
	`topic` text NOT NULL CHECK (`topic` = 'xyz.gnosyslabs.synapsis'),
	`follow_enabled` integer DEFAULT true NOT NULL,
	`reply_enabled` integer DEFAULT true NOT NULL,
	`mention_enabled` integer DEFAULT true NOT NULL,
	`like_enabled` integer DEFAULT true NOT NULL,
	`repost_enabled` integer DEFAULT true NOT NULL,
	`disabled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_user_installation_unique_idx` ON `push_subscriptions` (`user_id`,`installation_id`);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_relay_idx` ON `push_subscriptions` (`relay_subscription_id`);
--> statement-breakpoint
CREATE TABLE `push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending', 'processing', 'retry', 'delivered', 'dead')),
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_attempt_at` integer,
	`delivered_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_deliveries_notification_subscription_unique_idx` ON `push_deliveries` (`notification_id`,`subscription_id`);
--> statement-breakpoint
CREATE INDEX `push_deliveries_due_idx` ON `push_deliveries` (`status`,`next_attempt_at`);
--> statement-breakpoint
CREATE TRIGGER `notifications_enqueue_native_push`
AFTER INSERT ON `notifications`
BEGIN
	INSERT OR IGNORE INTO `push_deliveries` (
		`id`, `notification_id`, `subscription_id`, `status`, `attempts`,
		`next_attempt_at`, `created_at`, `updated_at`
	)
	SELECT
		lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
		substr(lower(hex(randomblob(2))), 2) || '-' ||
		substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
		lower(hex(randomblob(6))),
		NEW.`id`, subscriptions.`id`, 'pending', 0,
		unixepoch(), unixepoch(), unixepoch()
	FROM `push_subscriptions` AS subscriptions
	WHERE subscriptions.`user_id` = NEW.`user_id`
		AND subscriptions.`disabled_at` IS NULL
		AND CASE NEW.`type`
			WHEN 'follow' THEN subscriptions.`follow_enabled`
			WHEN 'reply' THEN subscriptions.`reply_enabled`
			WHEN 'mention' THEN subscriptions.`mention_enabled`
			WHEN 'like' THEN subscriptions.`like_enabled`
			WHEN 'repost' THEN subscriptions.`repost_enabled`
			ELSE 0
		END = 1;
END;
