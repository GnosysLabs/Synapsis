CREATE TABLE `__swarm_content_sync_states_backup` AS
SELECT * FROM `swarm_content_sync_states`;
--> statement-breakpoint
DROP TABLE `swarm_content_sync_states`;
--> statement-breakpoint
DELETE FROM `swarm_nodes`
WHERE rowid NOT IN (
  SELECT min(rowid)
  FROM `swarm_nodes`
  GROUP BY `domain`
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `swarm_nodes_domain_unique_idx`
  ON `swarm_nodes` (`domain`);
--> statement-breakpoint
CREATE TABLE `swarm_content_sync_states` (
  `domain` text PRIMARY KEY NOT NULL REFERENCES `swarm_nodes`(`domain`) ON DELETE CASCADE,
  `failures` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_attempt_at` integer,
  `last_success_at` integer,
  `high_water_at` integer,
  `high_water_id` text,
  `change_cursor` integer,
  `account_change_cursor` integer,
  `legacy_reconcile_cursor` text,
  `legacy_reconcile_complete` integer DEFAULT 0 NOT NULL,
  `lease_owner` text,
  `lease_expires_at` integer,
  `last_error` text,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `swarm_content_sync_states` (
  `domain`, `failures`, `next_attempt_at`, `last_attempt_at`, `last_success_at`,
  `high_water_at`, `high_water_id`, `change_cursor`, `account_change_cursor`,
  `legacy_reconcile_cursor`, `legacy_reconcile_complete`, `lease_owner`,
  `lease_expires_at`, `last_error`, `updated_at`
)
SELECT
  backup.`domain`, backup.`failures`, backup.`next_attempt_at`, backup.`last_attempt_at`,
  backup.`last_success_at`, backup.`high_water_at`, backup.`high_water_id`,
  backup.`change_cursor`, backup.`account_change_cursor`, backup.`legacy_reconcile_cursor`,
  backup.`legacy_reconcile_complete`, NULL, NULL, backup.`last_error`, backup.`updated_at`
FROM `__swarm_content_sync_states_backup` AS backup
INNER JOIN `swarm_nodes` AS node ON node.`domain` = backup.`domain`;
--> statement-breakpoint
DROP TABLE `__swarm_content_sync_states_backup`;
--> statement-breakpoint
CREATE INDEX `swarm_content_sync_due_idx`
  ON `swarm_content_sync_states` (`next_attempt_at`, `lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `swarm_content_sync_success_idx`
  ON `swarm_content_sync_states` (`last_success_at`);
