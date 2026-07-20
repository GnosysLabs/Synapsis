ALTER TABLE `swarm_change_notice_states`
  ADD COLUMN `relay_hints_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `swarm_change_notice_states`
  ADD COLUMN `direct_fallback_at` integer;
--> statement-breakpoint
CREATE INDEX `swarm_change_notice_pull_idx`
  ON `swarm_change_notice_states` (`source`, `pull_scheduled_at`);
--> statement-breakpoint
CREATE TABLE `swarm_change_bundles` (
  `origin_domain` text NOT NULL,
  `from_cursor` integer NOT NULL,
  `to_cursor` integer NOT NULL,
  `issued_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `bundle_json` text NOT NULL,
  `origin_signature` text NOT NULL,
  `cached_at` integer DEFAULT (unixepoch()) NOT NULL,
  `last_accessed_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `swarm_change_bundles_pk`
    PRIMARY KEY (`origin_domain`, `from_cursor`, `to_cursor`)
);
--> statement-breakpoint
CREATE INDEX `swarm_change_bundles_covering_idx`
  ON `swarm_change_bundles` (`origin_domain`, `from_cursor`, `to_cursor`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `swarm_change_bundles_expiry_idx`
  ON `swarm_change_bundles` (`expires_at`);
