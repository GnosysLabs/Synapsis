CREATE TABLE `swarm_inbound_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_domain` text NOT NULL,
	`action` text NOT NULL,
	`interaction_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_inbound_actions_replay_unique_idx` ON `swarm_inbound_actions` (`source_domain`,`action`,`interaction_id`);
--> statement-breakpoint
CREATE INDEX `swarm_inbound_actions_created_idx` ON `swarm_inbound_actions` (`created_at`);
