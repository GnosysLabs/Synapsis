CREATE TABLE `auth_abuse_quota_buckets` (
	`bucket_key` text NOT NULL,
	`bucket_start_ms` integer NOT NULL CHECK (`bucket_start_ms` >= 0),
	`event_count` integer DEFAULT 0 NOT NULL CHECK (`event_count` >= 0),
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `auth_abuse_quota_buckets_pk` PRIMARY KEY(`bucket_key`,`bucket_start_ms`),
	CONSTRAINT `auth_abuse_quota_buckets_key_length` CHECK (length(`bucket_key`) BETWEEN 1 AND 160)
);
--> statement-breakpoint
CREATE INDEX `auth_abuse_quota_buckets_start_idx` ON `auth_abuse_quota_buckets` (`bucket_start_ms`);
