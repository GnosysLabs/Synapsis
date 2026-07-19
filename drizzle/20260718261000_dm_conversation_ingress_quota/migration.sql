CREATE TABLE `chat_conversation_ingress_quota_buckets` (
	`recipient_user_id` text NOT NULL,
	`source_domain` text NOT NULL,
	`bucket_start_ms` integer NOT NULL CHECK (`bucket_start_ms` >= 0),
	`conversation_count` integer DEFAULT 0 NOT NULL CHECK (`conversation_count` >= 0),
	`message_count` integer DEFAULT 0 NOT NULL CHECK (`message_count` >= 0),
	`ciphertext_bytes` integer DEFAULT 0 NOT NULL CHECK (`ciphertext_bytes` >= 0),
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `chat_conversation_ingress_quota_buckets_pk` PRIMARY KEY(`recipient_user_id`,`source_domain`),
	CONSTRAINT `chat_conversation_ingress_quota_buckets_source_length` CHECK (length(`source_domain`) BETWEEN 1 AND 255),
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
