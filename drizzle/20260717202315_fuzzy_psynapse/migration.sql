ALTER TABLE `swarm_nodes` ADD `nsfw_classification_known` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `swarm_nodes` SET `nsfw_classification_known` = true WHERE `is_nsfw` = true;
