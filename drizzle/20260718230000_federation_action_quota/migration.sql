CREATE TABLE `swarm_federation_action_quota_buckets` (
	`source_domain` text NOT NULL,
	`bucket_start_ms` integer NOT NULL CHECK (`bucket_start_ms` >= 0),
	`action_count` integer DEFAULT 0 NOT NULL CHECK (`action_count` >= 0),
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `swarm_federation_action_quota_buckets_pk` PRIMARY KEY(`source_domain`,`bucket_start_ms`),
	CONSTRAINT `swarm_federation_action_quota_buckets_source_length` CHECK (length(`source_domain`) BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX `swarm_federation_action_quota_buckets_start_idx` ON `swarm_federation_action_quota_buckets` (`bucket_start_ms`);
