CREATE TABLE `feed_impressions` (
  `user_id` text NOT NULL,
  `post_key` text NOT NULL,
  `author_handle` text NOT NULL,
  `node_domain` text NOT NULL,
  `first_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
  `view_count` integer DEFAULT 1 NOT NULL,
  PRIMARY KEY (`user_id`, `post_key`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `feed_impressions_user_seen_idx`
  ON `feed_impressions` (`user_id`, `last_seen_at`);
--> statement-breakpoint
CREATE INDEX `feed_impressions_post_idx` ON `feed_impressions` (`post_key`);
--> statement-breakpoint

CREATE TABLE `feed_feedback` (
  `user_id` text NOT NULL,
  `post_key` text NOT NULL,
  `author_handle` text NOT NULL,
  `node_domain` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('not_interested')),
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  PRIMARY KEY (`user_id`, `post_key`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `feed_feedback_user_kind_idx`
  ON `feed_feedback` (`user_id`, `kind`, `updated_at`);
--> statement-breakpoint

CREATE TABLE `for_you_feed_sessions` (
  `id` text PRIMARY KEY,
  `user_id` text NOT NULL,
  `snapshot_at` integer DEFAULT (unixepoch()) NOT NULL,
  `next_position` integer DEFAULT 0 NOT NULL,
  `diversity_state_json` text DEFAULT '{}' NOT NULL,
  `exhausted` integer DEFAULT 0 NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `for_you_feed_sessions_user_idx`
  ON `for_you_feed_sessions` (`user_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `for_you_feed_sessions_expiry_idx`
  ON `for_you_feed_sessions` (`expires_at`);
--> statement-breakpoint

CREATE TABLE `for_you_feed_items` (
  `session_id` text NOT NULL,
  `position` integer NOT NULL,
  `post_key` text NOT NULL,
  `feed_meta_json` text NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  PRIMARY KEY (`session_id`, `position`),
  FOREIGN KEY (`session_id`) REFERENCES `for_you_feed_sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `for_you_feed_items_post_unique_idx`
  ON `for_you_feed_items` (`session_id`, `post_key`);
--> statement-breakpoint

-- Earlier releases retained only 250 cached posts per peer. Reset content
-- cursors once so upgraded nodes replay each origin's coalesced change stream
-- from sequence zero and rebuild the complete current corpus in bounded pages.
UPDATE `swarm_content_sync_states`
SET
  `change_cursor` = NULL,
  `high_water_at` = NULL,
  `high_water_id` = NULL,
  `failures` = 0,
  `next_attempt_at` = unixepoch(),
  `lease_owner` = NULL,
  `lease_expires_at` = NULL,
  `last_error` = NULL,
  `updated_at` = unixepoch();
