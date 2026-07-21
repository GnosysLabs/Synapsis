ALTER TABLE `users` ADD `stuffbox_badge_proof` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `stuffbox_badge_level` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `stuffbox_badge_plan` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `stuffbox_badge_issuer` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `stuffbox_badge_expires_at` integer;
--> statement-breakpoint
CREATE INDEX `users_stuffbox_badge_idx` ON `users` (`stuffbox_badge_level`,`stuffbox_badge_expires_at`);
