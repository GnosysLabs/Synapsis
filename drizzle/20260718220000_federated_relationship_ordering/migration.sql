CREATE TABLE `swarm_relationship_states` (
	`id` text PRIMARY KEY NOT NULL,
	`source_domain` text NOT NULL,
	`actor_did` text NOT NULL,
	`relationship_kind` text NOT NULL CHECK (`relationship_kind` IN ('like', 'follow', 'repost')),
	`target` text NOT NULL,
	`last_action_ts` integer NOT NULL,
	`last_action_tie_breaker` text NOT NULL CHECK (length(`last_action_tie_breaker`) = 64),
	`state` integer NOT NULL CHECK (`state` IN (0, 1)),
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_relationship_states_identity_unique_idx` ON `swarm_relationship_states` (`source_domain`,`actor_did`,`relationship_kind`,`target`);
--> statement-breakpoint
CREATE INDEX `swarm_relationship_states_actor_idx` ON `swarm_relationship_states` (`source_domain`,`actor_did`);
