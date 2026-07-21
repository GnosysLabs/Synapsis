ALTER TABLE `swarm_account_tombstones` ADD `moved_to` text;
--> statement-breakpoint
ALTER TABLE `swarm_account_tombstones` ADD `migrated_at` integer;
--> statement-breakpoint
CREATE TABLE `account_move_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL UNIQUE,
  `source_node` text NOT NULL,
  `source_protocol` text NOT NULL,
  `old_handle` text NOT NULL,
  `new_actor_url` text NOT NULL,
  `did` text NOT NULL,
  `moved_at` integer NOT NULL,
  `signature` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_error` text,
  `confirmed_at` integer,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_move_deliveries_due_idx`
ON `account_move_deliveries` (`status`, `next_attempt_at`);
