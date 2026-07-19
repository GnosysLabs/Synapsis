CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`cover_url` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collections_user_idx` ON `collections` (`user_id`);
--> statement-breakpoint
CREATE INDEX `collections_user_sort_idx` ON `collections` (`user_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `collection_posts` (
	`collection_id` text NOT NULL,
	`post_id` text NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `collection_posts_pk` PRIMARY KEY(`collection_id`,`post_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collection_posts_collection_idx` ON `collection_posts` (`collection_id`);
--> statement-breakpoint
CREATE INDEX `collection_posts_post_idx` ON `collection_posts` (`post_id`);
