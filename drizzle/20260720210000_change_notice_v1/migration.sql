CREATE TABLE `swarm_change_notice_states` (
  `origin_domain` text PRIMARY KEY NOT NULL,
  `sequence` integer NOT NULL,
  `issued_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `notice_json` text NOT NULL,
  `origin_signature` text NOT NULL,
  `source` text NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `relay_round` integer DEFAULT 0 NOT NULL,
  `relay_targets_json` text DEFAULT '[]' NOT NULL,
  `attempts` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_attempt_at` integer,
  `first_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_received_at` integer,
  `last_forwarded_at` integer,
  `pull_scheduled_at` integer,
  `last_delay_ms` integer,
  `last_error` text,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `swarm_change_notice_due_idx`
  ON `swarm_change_notice_states` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `swarm_change_notice_received_idx`
  ON `swarm_change_notice_states` (`source`, `last_received_at`);
