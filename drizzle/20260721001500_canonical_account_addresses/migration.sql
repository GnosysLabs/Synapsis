-- Canonical account-address cutover.
--
-- scripts/migrate.ts creates exactly one context row from the normalized
-- NEXT_PUBLIC_NODE_DOMAIN before Drizzle enters this migration.  The context
-- is deliberately external to legacy handle punctuation: punctuation is data
-- being migrated, never authority for the node's identity.
CREATE TEMP TABLE `__identity_cutover_guard` (
  `ok` integer NOT NULL CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE WHEN count(*) = 1 THEN 1 ELSE 0 END
FROM `__identity_migration_context`
WHERE `id` = 1
  AND `local_domain` = lower(`local_domain`)
  AND length(`local_domain`) > 0
  AND instr(`local_domain`, '@') = 0
  AND instr(`local_domain`, '/') = 0;
--> statement-breakpoint

-- The retired bootstrap hostname and the public node hostname name the same
-- cryptographic identity.  Canonicalize that alias before any address plans
-- are built, so a legacy seed spelling cannot create a second account.  Every
-- statement is inside Drizzle's migration transaction; an existing UNIQUE
-- constraint aborts the whole cutover rather than merging colliding rows.
-- Drop the legacy ownership triggers first so this normalization cannot emit
-- a synthetic account-change record.
DROP TRIGGER IF EXISTS `swarm_post_changes_posts_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_posts_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_posts_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_users_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_media_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_media_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_media_update`;
--> statement-breakpoint

UPDATE `nodes`
SET `domain` = 'synapsis.social'
WHERE lower(trim(`domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `handle_registry`
SET `node_domain` = 'synapsis.social'
WHERE lower(trim(`node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_posts`
SET `node_domain` = 'synapsis.social'
WHERE lower(trim(`node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_likes`
SET `actor_node_domain` = 'synapsis.social'
WHERE lower(trim(`actor_node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_reposts`
SET `actor_node_domain` = 'synapsis.social'
WHERE lower(trim(`actor_node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `user_swarm_likes`
SET `node_domain` = 'synapsis.social'
WHERE lower(trim(`node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `user_swarm_reposts`
SET `node_domain` = 'synapsis.social'
WHERE lower(trim(`node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `notifications`
SET `actor_node_domain` = 'synapsis.social'
WHERE lower(trim(`actor_node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `mention_deliveries`
SET `target_domain` = 'synapsis.social'
WHERE lower(trim(`target_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_follow_sync_states`
SET `node_domain` = 'synapsis.social'
WHERE lower(trim(`node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint
UPDATE `chat_messages`
SET `sender_node_domain` = 'synapsis.social'
WHERE lower(trim(`sender_node_domain`)) = 'node.synapsis.social';
--> statement-breakpoint

UPDATE `users`
SET `handle` = replace(lower(trim(`handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `handle_registry`
SET `handle` = replace(lower(trim(`handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `swarm_account_tombstones`
SET `handle` = replace(lower(trim(`handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_follows`
SET `target_handle` = replace(lower(trim(`target_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`target_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_followers`
SET `handle` = replace(lower(trim(`handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE `handle` IS NOT NULL
  AND lower(trim(`handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_posts`
SET `author_handle` = replace(lower(trim(`author_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`author_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_likes`
SET `actor_handle` = replace(lower(trim(`actor_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`actor_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_reposts`
SET `actor_handle` = replace(lower(trim(`actor_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`actor_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `user_swarm_likes`
SET `author_handle` = replace(lower(trim(`author_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`author_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `user_swarm_reposts`
SET `author_handle` = replace(lower(trim(`author_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`author_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `notifications`
SET `actor_handle` = replace(lower(trim(`actor_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`actor_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `mention_deliveries`
SET `target_handle` = replace(lower(trim(`target_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`target_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `remote_follow_sync_states`
SET `target_handle` = replace(lower(trim(`target_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`target_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `chat_conversations`
SET `participant2_handle` = replace(lower(trim(`participant2_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`participant2_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `chat_messages`
SET `sender_handle` = replace(lower(trim(`sender_handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`sender_handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint
UPDATE `e2ee_remote_key_bundles`
SET `handle` = replace(lower(trim(`handle`)), '@node.synapsis.social', '@synapsis.social')
WHERE lower(trim(`handle`)) LIKE '%@node.synapsis.social';
--> statement-breakpoint

-- Freeze the legacy classification once.  Later code must use
-- is_local_account and must not recover ownership from the address shape.
CREATE TEMP TABLE `__identity_user_address_plan` (
  `user_id` text PRIMARY KEY NOT NULL,
  `did` text NOT NULL,
  `canonical_handle` text NOT NULL UNIQUE,
  `username` text NOT NULL,
  `home_domain` text NOT NULL,
  `is_local_account` integer NOT NULL CHECK (`is_local_account` IN (0, 1)),
  CHECK (`canonical_handle` = `username` || '@' || `home_domain`),
  CHECK (length(`username`) BETWEEN 3 AND 30),
  CHECK (instr(`username`, '@') = 0),
  CHECK (length(`home_domain`) > 0),
  CHECK (instr(`home_domain`, '@') = 0),
  CHECK (instr(`home_domain`, '/') = 0)
);
--> statement-breakpoint
INSERT INTO `__identity_user_address_plan` (
  `user_id`, `did`, `canonical_handle`, `username`, `home_domain`, `is_local_account`
)
WITH `clean_users` AS (
  SELECT
    `legacy`.`id` AS `user_id`,
    `legacy`.`did` AS `did`,
    `legacy`.`node_id` AS `node_id`,
    lower(trim(CASE
      WHEN substr(trim(`legacy`.`handle`), 1, 1) = '@'
        THEN substr(trim(`legacy`.`handle`), 2)
      ELSE trim(`legacy`.`handle`)
    END)) AS `clean_handle`,
    lower(trim(`origin_node`.`domain`)) AS `node_domain`,
    (SELECT `local_domain` FROM `__identity_migration_context` WHERE `id` = 1) AS `local_domain`
  FROM `users` AS `legacy`
  LEFT JOIN `nodes` AS `origin_node` ON `origin_node`.`id` = `legacy`.`node_id`
),
`parsed_users` AS (
  SELECT
    *,
    instr(`clean_handle`, '@') AS `separator`,
    length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) AS `separator_count`
  FROM `clean_users`
),
`addressed_users` AS (
  SELECT
    `user_id`,
    `did`,
    CASE WHEN `separator` > 0 THEN substr(`clean_handle`, 1, `separator` - 1) ELSE `clean_handle` END AS `username`,
    CASE
      WHEN `separator` > 0 THEN substr(`clean_handle`, `separator` + 1)
      WHEN `node_id` IS NULL THEN `local_domain`
      ELSE `node_domain`
    END AS `home_domain`,
    `separator_count`,
    `node_id`,
    `node_domain`,
    `local_domain`
  FROM `parsed_users`
)
SELECT
  `user_id`,
  `did`,
  `username` || '@' || `home_domain`,
  `username`,
  `home_domain`,
  CASE WHEN `node_id` IS NULL AND `home_domain` = `local_domain` THEN 1 ELSE 0 END
FROM `addressed_users`
WHERE `separator_count` IN (0, 1)
  AND (`node_id` IS NULL OR `node_domain` IS NOT NULL)
  AND (`node_id` IS NULL OR `separator_count` = 0 OR `home_domain` = `node_domain`)
  AND (`node_id` IS NOT NULL OR `separator_count` = 0 OR `home_domain` IS NOT NULL);
--> statement-breakpoint

-- A filtered INSERT above must account for every user.  Anything missing is
-- malformed, ambiguously attributed, or disagrees with its explicit node row.
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_user_address_plan`) = (SELECT count(*) FROM `users`)
    THEN 1 ELSE 0
END;
--> statement-breakpoint

-- These triggers encode the legacy local-user test.  Drop them before the
-- parent-table rebuild and recreate them against is_local_account below.
DROP TRIGGER IF EXISTS `swarm_post_changes_posts_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_posts_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_posts_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_users_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_media_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_media_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `swarm_post_changes_media_update`;
--> statement-breakpoint

-- scripts/migrate.ts disables foreign-key enforcement before Drizzle opens
-- its migration transaction and restores it immediately afterward.  IDs are
-- copied unchanged, so every child FK, session, CLI credential, and local
-- relationship continues to point at the same account.
CREATE TABLE `__new_users` (
  `id` text PRIMARY KEY,
  `did` text NOT NULL,
  `handle` text NOT NULL,
  `username` text NOT NULL,
  `home_domain` text NOT NULL,
  `is_local_account` integer NOT NULL,
  `email` text UNIQUE,
  `password_hash` text,
  `display_name` text,
  `bio` text,
  `avatar_url` text,
  `header_url` text,
  `private_key_encrypted` text,
  `public_key` text NOT NULL,
  `node_id` text,
  `is_nsfw` integer DEFAULT false NOT NULL,
  `nsfw_enabled` integer DEFAULT false NOT NULL,
  `age_verified_at` integer,
  `is_suspended` integer DEFAULT false NOT NULL,
  `suspension_reason` text,
  `suspended_at` integer,
  `is_silenced` integer DEFAULT false NOT NULL,
  `silence_reason` text,
  `silenced_at` integer,
  `moved_to` text,
  `moved_from` text,
  `migrated_at` integer,
  `storage_provider` text,
  `storage_endpoint` text,
  `storage_public_base_url` text,
  `storage_region` text,
  `storage_bucket` text,
  `storage_access_key_encrypted` text,
  `storage_secret_key_encrypted` text,
  `followers_count` integer DEFAULT 0 NOT NULL,
  `following_count` integer DEFAULT 0 NOT NULL,
  `posts_count` integer DEFAULT 0 NOT NULL,
  `website` text,
  `dm_privacy` text DEFAULT 'everyone' NOT NULL,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `fk_users_node_id_nodes_id_fk`
    FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`),
  CONSTRAINT `users_identity_origin_check`
    CHECK (`is_local_account` IN (0, 1)),
  CONSTRAINT `users_identity_address_check`
    CHECK (`handle` = `username` || '@' || `home_domain`),
  CONSTRAINT `users_identity_normalization_check`
    CHECK (
      `handle` = lower(`handle`)
      AND `username` = lower(`username`)
      AND `home_domain` = lower(`home_domain`)
      AND length(`username`) BETWEEN 3 AND 30
      AND instr(`username`, '@') = 0
      AND length(`home_domain`) > 0
      AND instr(`home_domain`, '@') = 0
      AND instr(`home_domain`, '/') = 0
    )
);
--> statement-breakpoint
INSERT INTO `__new_users` (
  `id`, `did`, `handle`, `username`, `home_domain`, `is_local_account`,
  `email`, `password_hash`, `display_name`, `bio`, `avatar_url`, `header_url`,
  `private_key_encrypted`, `public_key`, `node_id`, `is_nsfw`, `nsfw_enabled`,
  `age_verified_at`, `is_suspended`, `suspension_reason`, `suspended_at`,
  `is_silenced`, `silence_reason`, `silenced_at`, `moved_to`, `moved_from`,
  `migrated_at`, `storage_provider`, `storage_endpoint`, `storage_public_base_url`,
  `storage_region`, `storage_bucket`, `storage_access_key_encrypted`,
  `storage_secret_key_encrypted`, `followers_count`, `following_count`,
  `posts_count`, `website`, `dm_privacy`, `created_at`, `updated_at`
)
SELECT
  `legacy`.`id`,
  `legacy`.`did`,
  `plan`.`canonical_handle`,
  `plan`.`username`,
  `plan`.`home_domain`,
  `plan`.`is_local_account`,
  `legacy`.`email`,
  `legacy`.`password_hash`,
  `legacy`.`display_name`,
  `legacy`.`bio`,
  `legacy`.`avatar_url`,
  `legacy`.`header_url`,
  `legacy`.`private_key_encrypted`,
  `legacy`.`public_key`,
  `legacy`.`node_id`,
  `legacy`.`is_nsfw`,
  `legacy`.`nsfw_enabled`,
  `legacy`.`age_verified_at`,
  `legacy`.`is_suspended`,
  `legacy`.`suspension_reason`,
  `legacy`.`suspended_at`,
  `legacy`.`is_silenced`,
  `legacy`.`silence_reason`,
  `legacy`.`silenced_at`,
  `legacy`.`moved_to`,
  `legacy`.`moved_from`,
  `legacy`.`migrated_at`,
  `legacy`.`storage_provider`,
  `legacy`.`storage_endpoint`,
  `legacy`.`storage_public_base_url`,
  `legacy`.`storage_region`,
  `legacy`.`storage_bucket`,
  `legacy`.`storage_access_key_encrypted`,
  `legacy`.`storage_secret_key_encrypted`,
  `legacy`.`followers_count`,
  `legacy`.`following_count`,
  `legacy`.`posts_count`,
  `legacy`.`website`,
  `legacy`.`dm_privacy`,
  `legacy`.`created_at`,
  `legacy`.`updated_at`
FROM `users` AS `legacy`
INNER JOIN `__identity_user_address_plan` AS `plan`
  ON `plan`.`user_id` = `legacy`.`id`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
--> statement-breakpoint
CREATE INDEX `users_handle_idx` ON `users` (`handle`);
--> statement-breakpoint
CREATE INDEX `users_did_idx` ON `users` (`did`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_unique_idx` ON `users` (`handle`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_home_username_unique_idx` ON `users` (`home_domain`, `username`);
--> statement-breakpoint
CREATE INDEX `users_local_username_idx` ON `users` (`is_local_account`, `username`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_did_unique_idx` ON `users` (`did`);
--> statement-breakpoint
CREATE INDEX `users_suspended_idx` ON `users` (`is_suspended`);
--> statement-breakpoint
CREATE INDEX `users_silenced_idx` ON `users` (`is_silenced`);
--> statement-breakpoint
CREATE INDEX `users_nsfw_idx` ON `users` (`is_nsfw`);
--> statement-breakpoint

-- Registry aliases are security state.  Build a complete, uniquely indexed
-- plan first so case-folding or qualification can never pick a winner between
-- two identities.
CREATE TEMP TABLE `__identity_registry_plan` (
  `old_handle` text PRIMARY KEY NOT NULL,
  `canonical_handle` text NOT NULL UNIQUE,
  `home_domain` text NOT NULL,
  `did` text NOT NULL,
  `identity_verified` integer NOT NULL,
  CHECK (`canonical_handle` = lower(`canonical_handle`)),
  CHECK (instr(`canonical_handle`, '@') > 1),
  CHECK (`home_domain` = lower(`home_domain`)),
  CHECK (length(`home_domain`) > 0),
  CHECK (instr(`home_domain`, '@') = 0),
  CHECK (instr(`home_domain`, '/') = 0)
);
--> statement-breakpoint
INSERT INTO `__identity_registry_plan` (
  `old_handle`, `canonical_handle`, `home_domain`, `did`, `identity_verified`
)
WITH `clean_registry` AS (
  SELECT
    `handle` AS `old_handle`,
    `did`,
    `identity_verified`,
    lower(trim(`node_domain`)) AS `home_domain`,
    lower(trim(CASE
      WHEN substr(trim(`handle`), 1, 1) = '@' THEN substr(trim(`handle`), 2)
      ELSE trim(`handle`)
    END)) AS `clean_handle`
  FROM `handle_registry`
)
SELECT
  `old_handle`,
  CASE
    WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
    ELSE `clean_handle` || '@' || `home_domain`
  END,
  `home_domain`,
  `did`,
  `identity_verified`
FROM `clean_registry`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND length(`home_domain`) > 0
  AND (
    instr(`clean_handle`, '@') = 0
    OR substr(`clean_handle`, instr(`clean_handle`, '@') + 1) = `home_domain`
  );
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_registry_plan`) = (SELECT count(*) FROM `handle_registry`)
    THEN 1 ELSE 0
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `__identity_registry_verified_owner_unique`
ON `__identity_registry_plan` (`home_domain`, `did`)
WHERE `identity_verified` = 1;
--> statement-breakpoint
UPDATE `handle_registry`
SET
  `handle` = (
    SELECT `canonical_handle` FROM `__identity_registry_plan`
    WHERE `old_handle` = `handle_registry`.`handle`
  ),
  `node_domain` = (
    SELECT `home_domain` FROM `__identity_registry_plan`
    WHERE `old_handle` = `handle_registry`.`handle`
  );
--> statement-breakpoint

-- Local deletion tombstones acquire the same explicit components.  Their
-- sequence and timestamp remain untouched so account-change cursors retain
-- their exact historical ordering.
CREATE TEMP TABLE `__identity_tombstone_plan` (
  `old_handle` text PRIMARY KEY NOT NULL,
  `canonical_handle` text NOT NULL UNIQUE,
  `username` text NOT NULL,
  `home_domain` text NOT NULL,
  CHECK (`canonical_handle` = `username` || '@' || `home_domain`)
);
--> statement-breakpoint
INSERT INTO `__identity_tombstone_plan` (`old_handle`, `canonical_handle`, `username`, `home_domain`)
WITH `clean_tombstones` AS (
  SELECT
    `handle` AS `old_handle`,
    lower(trim(CASE
      WHEN substr(trim(`handle`), 1, 1) = '@' THEN substr(trim(`handle`), 2)
      ELSE trim(`handle`)
    END)) AS `clean_handle`,
    (SELECT `local_domain` FROM `__identity_migration_context` WHERE `id` = 1) AS `local_domain`
  FROM `swarm_account_tombstones`
),
`addressed_tombstones` AS (
  SELECT
    `old_handle`,
    CASE
      WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
      ELSE `clean_handle` || '@' || `local_domain`
    END AS `canonical_handle`,
    `local_domain`
  FROM `clean_tombstones`
  WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
)
SELECT
  `old_handle`,
  `canonical_handle`,
  substr(`canonical_handle`, 1, instr(`canonical_handle`, '@') - 1),
  substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1)
FROM `addressed_tombstones`
WHERE instr(`canonical_handle`, '@') > 1
  AND substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `local_domain`;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_tombstone_plan`) = (SELECT count(*) FROM `swarm_account_tombstones`)
    THEN 1 ELSE 0
END;
--> statement-breakpoint
CREATE TABLE `__new_swarm_account_tombstones` (
  `handle` text PRIMARY KEY NOT NULL,
  `username` text NOT NULL,
  `home_domain` text NOT NULL,
  `did` text NOT NULL,
  `sequence` integer NOT NULL,
  `deleted_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `swarm_account_tombstones_address_check`
    CHECK (`handle` = `username` || '@' || `home_domain`),
  CONSTRAINT `swarm_account_tombstones_normalization_check`
    CHECK (
      `handle` = lower(`handle`)
      AND `username` = lower(`username`)
      AND `home_domain` = lower(`home_domain`)
      AND instr(`username`, '@') = 0
      AND instr(`home_domain`, '@') = 0
    )
);
--> statement-breakpoint
INSERT INTO `__new_swarm_account_tombstones` (
  `handle`, `username`, `home_domain`, `did`, `sequence`, `deleted_at`
)
SELECT
  `plan`.`canonical_handle`,
  `plan`.`username`,
  `plan`.`home_domain`,
  `legacy`.`did`,
  `legacy`.`sequence`,
  `legacy`.`deleted_at`
FROM `swarm_account_tombstones` AS `legacy`
INNER JOIN `__identity_tombstone_plan` AS `plan`
  ON `plan`.`old_handle` = `legacy`.`handle`;
--> statement-breakpoint
DROP TABLE `swarm_account_tombstones`;
--> statement-breakpoint
ALTER TABLE `__new_swarm_account_tombstones` RENAME TO `swarm_account_tombstones`;
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_account_tombstones_sequence_idx`
ON `swarm_account_tombstones` (`sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_account_tombstones_home_username_unique_idx`
ON `swarm_account_tombstones` (`home_domain`, `username`);
--> statement-breakpoint
CREATE INDEX `swarm_account_tombstones_deleted_idx`
ON `swarm_account_tombstones` (`deleted_at`);
--> statement-breakpoint

-- Plan every unsigned handle projection before changing any of them.  The
-- optional collision key mirrors each table's handle-bearing uniqueness rule;
-- its UNIQUE index turns every canonical collision into an atomic abort.
CREATE TEMP TABLE `__identity_projection_plan` (
  `table_name` text NOT NULL,
  `row_key` text NOT NULL,
  `canonical_handle` text NOT NULL,
  `home_domain` text NOT NULL,
  `collision_key` text,
  PRIMARY KEY (`table_name`, `row_key`),
  CHECK (`canonical_handle` = lower(`canonical_handle`)),
  CHECK (`home_domain` = lower(`home_domain`)),
  CHECK (instr(`home_domain`, '@') = 0),
  CHECK (instr(`home_domain`, '/') = 0),
  CHECK (length(`canonical_handle`) - length(replace(`canonical_handle`, '@', '')) = 1),
  CHECK (instr(`canonical_handle`, '@') > 1),
  CHECK (substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `home_domain`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `__identity_projection_collision_unique`
ON `__identity_projection_plan` (`collision_key`)
WHERE `collision_key` IS NOT NULL;
--> statement-breakpoint

-- Outgoing remote follows have always documented target_handle as qualified.
-- A bare legacy row has no separate authoritative domain and therefore fails
-- the row-count guard instead of guessing from a mutable URL.
INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `id`,
    `follower_id`,
    lower(trim(CASE
      WHEN substr(trim(`target_handle`), 1, 1) = '@' THEN substr(trim(`target_handle`), 2)
      ELSE trim(`target_handle`)
    END)) AS `clean_handle`
  FROM `remote_follows`
)
SELECT
  'remote_follows',
  `id`,
  `clean_handle`,
  substr(`clean_handle`, instr(`clean_handle`, '@') + 1),
  'remote_follows|' || `follower_id` || '|' || `clean_handle`
FROM `clean_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) = 1
  AND instr(`clean_handle`, '@') > 1;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'remote_follows')
    = (SELECT count(*) FROM `remote_follows`) THEN 1 ELSE 0
END;
--> statement-breakpoint

-- Remote follower rows may omit the presentation handle entirely.  Non-null
-- handles must already identify their home node; actor_url is not treated as
-- identity authority during a cryptographic-account migration.
INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `id`,
    lower(trim(CASE
      WHEN substr(trim(`handle`), 1, 1) = '@' THEN substr(trim(`handle`), 2)
      ELSE trim(`handle`)
    END)) AS `clean_handle`
  FROM `remote_followers`
  WHERE `handle` IS NOT NULL
)
SELECT
  'remote_followers',
  `id`,
  `clean_handle`,
  substr(`clean_handle`, instr(`clean_handle`, '@') + 1),
  NULL
FROM `clean_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) = 1
  AND instr(`clean_handle`, '@') > 1;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'remote_followers')
    = (SELECT count(*) FROM `remote_followers` WHERE `handle` IS NOT NULL) THEN 1 ELSE 0
END;
--> statement-breakpoint

INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `id`,
    lower(trim(CASE
      WHEN substr(trim(`author_handle`), 1, 1) = '@' THEN substr(trim(`author_handle`), 2)
      ELSE trim(`author_handle`)
    END)) AS `clean_handle`,
    CASE WHEN `node_domain` IS NULL THEN NULL ELSE lower(trim(`node_domain`)) END AS `clean_domain`
  FROM `remote_posts`
),
`addressed_rows` AS (
  SELECT
    `id`,
    CASE
      WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
      WHEN `clean_domain` IS NOT NULL THEN `clean_handle` || '@' || `clean_domain`
      ELSE NULL
    END AS `canonical_handle`,
    `clean_domain`
  FROM `clean_rows`
  WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
)
SELECT
  'remote_posts',
  `id`,
  `canonical_handle`,
  substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1),
  NULL
FROM `addressed_rows`
WHERE `canonical_handle` IS NOT NULL
  AND instr(`canonical_handle`, '@') > 1
  AND (`clean_domain` IS NULL OR substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `clean_domain`);
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'remote_posts')
    = (SELECT count(*) FROM `remote_posts`) THEN 1 ELSE 0
END;
--> statement-breakpoint

-- Tables with an explicit actor/author domain can safely qualify legacy bare
-- projections.  Their existing relationship keys become collision keys.
INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `id`, `post_id`, lower(trim(`actor_node_domain`)) AS `clean_domain`,
    lower(trim(CASE
      WHEN substr(trim(`actor_handle`), 1, 1) = '@' THEN substr(trim(`actor_handle`), 2)
      ELSE trim(`actor_handle`)
    END)) AS `clean_handle`
  FROM `remote_likes`
),
`addressed_rows` AS (
  SELECT *, CASE
    WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
    ELSE `clean_handle` || '@' || `clean_domain`
  END AS `canonical_handle`
  FROM `clean_rows`
)
SELECT
  'remote_likes', `id`, `canonical_handle`, `clean_domain`,
  'remote_likes|' || `post_id` || '|' || `canonical_handle`
FROM `addressed_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND length(`clean_domain`) > 0
  AND substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `clean_domain`;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'remote_likes')
    = (SELECT count(*) FROM `remote_likes`) THEN 1 ELSE 0
END;
--> statement-breakpoint

INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `id`, `post_id`, lower(trim(`actor_node_domain`)) AS `clean_domain`,
    lower(trim(CASE
      WHEN substr(trim(`actor_handle`), 1, 1) = '@' THEN substr(trim(`actor_handle`), 2)
      ELSE trim(`actor_handle`)
    END)) AS `clean_handle`
  FROM `remote_reposts`
),
`addressed_rows` AS (
  SELECT *, CASE
    WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
    ELSE `clean_handle` || '@' || `clean_domain`
  END AS `canonical_handle`
  FROM `clean_rows`
)
SELECT
  'remote_reposts', `id`, `canonical_handle`, `clean_domain`,
  'remote_reposts|' || `post_id` || '|' || `canonical_handle`
FROM `addressed_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND length(`clean_domain`) > 0
  AND substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `clean_domain`;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'remote_reposts')
    = (SELECT count(*) FROM `remote_reposts`) THEN 1 ELSE 0
END;
--> statement-breakpoint

INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `source_rows` AS (
  SELECT 'user_swarm_likes' AS `table_name`, `id`, lower(trim(`node_domain`)) AS `clean_domain`, `author_handle`
  FROM `user_swarm_likes`
  UNION ALL
  SELECT 'user_swarm_reposts', `id`, lower(trim(`node_domain`)), `author_handle`
  FROM `user_swarm_reposts`
),
`clean_rows` AS (
  SELECT
    `table_name`, `id`, `clean_domain`,
    lower(trim(CASE
      WHEN substr(trim(`author_handle`), 1, 1) = '@' THEN substr(trim(`author_handle`), 2)
      ELSE trim(`author_handle`)
    END)) AS `clean_handle`
  FROM `source_rows`
),
`addressed_rows` AS (
  SELECT *, CASE
    WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
    ELSE `clean_handle` || '@' || `clean_domain`
  END AS `canonical_handle`
  FROM `clean_rows`
)
SELECT `table_name`, `id`, `canonical_handle`, `clean_domain`, NULL
FROM `addressed_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND length(`clean_domain`) > 0
  AND substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `clean_domain`;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE WHEN
  (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'user_swarm_likes')
    = (SELECT count(*) FROM `user_swarm_likes`)
  AND
  (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'user_swarm_reposts')
    = (SELECT count(*) FROM `user_swarm_reposts`)
  THEN 1 ELSE 0 END;
--> statement-breakpoint

-- Notification actor_id is stronger than its mutable presentation snapshot.
-- Without actor_id, actor_node_domain is authoritative; its documented NULL
-- value denotes a legacy local actor and therefore uses the migration context.
INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `notification`.`id`,
    `notification`.`actor_id`,
    `notification`.`actor_node_domain`,
    `owner`.`handle` AS `owner_handle`,
    `owner`.`home_domain` AS `owner_domain`,
    lower(trim(CASE
      WHEN substr(trim(`notification`.`actor_handle`), 1, 1) = '@'
        THEN substr(trim(`notification`.`actor_handle`), 2)
      ELSE trim(`notification`.`actor_handle`)
    END)) AS `clean_handle`,
    CASE
      WHEN `notification`.`actor_node_domain` IS NULL
        THEN (SELECT `local_domain` FROM `__identity_migration_context` WHERE `id` = 1)
      ELSE lower(trim(`notification`.`actor_node_domain`))
    END AS `fallback_domain`
  FROM `notifications` AS `notification`
  LEFT JOIN `users` AS `owner` ON `owner`.`id` = `notification`.`actor_id`
),
`addressed_rows` AS (
  SELECT
    *,
    CASE
      WHEN `actor_id` IS NOT NULL THEN `owner_handle`
      WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
      ELSE `clean_handle` || '@' || `fallback_domain`
    END AS `canonical_handle`,
    CASE
      WHEN `actor_id` IS NOT NULL THEN `owner_domain`
      WHEN instr(`clean_handle`, '@') > 0 THEN substr(`clean_handle`, instr(`clean_handle`, '@') + 1)
      ELSE `fallback_domain`
    END AS `home_domain`
  FROM `clean_rows`
)
SELECT 'notifications', `id`, `canonical_handle`, `home_domain`, NULL
FROM `addressed_rows`
WHERE `canonical_handle` IS NOT NULL
  AND (`actor_id` IS NULL OR `owner_handle` IS NOT NULL)
  AND length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND (
    `actor_id` IS NULL
    OR instr(`clean_handle`, '@') = 0
    OR `clean_handle` = `owner_handle`
  )
  AND (
    `actor_id` IS NOT NULL
    OR `actor_node_domain` IS NULL
    OR instr(`clean_handle`, '@') = 0
    OR substr(`clean_handle`, instr(`clean_handle`, '@') + 1) = `fallback_domain`
  );
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'notifications')
    = (SELECT count(*) FROM `notifications`) THEN 1 ELSE 0
END;
--> statement-breakpoint

INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `id`, `post_id`, lower(trim(`target_domain`)) AS `clean_domain`,
    lower(trim(CASE
      WHEN substr(trim(`target_handle`), 1, 1) = '@' THEN substr(trim(`target_handle`), 2)
      ELSE trim(`target_handle`)
    END)) AS `clean_handle`
  FROM `mention_deliveries`
),
`addressed_rows` AS (
  SELECT *, CASE
    WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
    ELSE `clean_handle` || '@' || `clean_domain`
  END AS `canonical_handle`
  FROM `clean_rows`
)
SELECT
  'mention_deliveries', `id`, `canonical_handle`, `clean_domain`,
  'mention_deliveries|' || `post_id` || '|' || `canonical_handle`
FROM `addressed_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND length(`clean_domain`) > 0
  AND substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `clean_domain`;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'mention_deliveries')
    = (SELECT count(*) FROM `mention_deliveries`) THEN 1 ELSE 0
END;
--> statement-breakpoint

INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `target_handle` AS `old_handle`,
    lower(trim(`node_domain`)) AS `clean_domain`,
    lower(trim(CASE
      WHEN substr(trim(`target_handle`), 1, 1) = '@' THEN substr(trim(`target_handle`), 2)
      ELSE trim(`target_handle`)
    END)) AS `clean_handle`
  FROM `remote_follow_sync_states`
),
`addressed_rows` AS (
  SELECT *, CASE
    WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
    ELSE `clean_handle` || '@' || `clean_domain`
  END AS `canonical_handle`
  FROM `clean_rows`
)
SELECT
  'remote_follow_sync_states', `old_handle`, `canonical_handle`, `clean_domain`,
  'remote_follow_sync_states|' || `canonical_handle`
FROM `addressed_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND length(`clean_domain`) > 0
  AND substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1) = `clean_domain`;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'remote_follow_sync_states')
    = (SELECT count(*) FROM `remote_follow_sync_states`) THEN 1 ELSE 0
END;
--> statement-breakpoint

-- A bare direct-chat partner was the legacy representation of a same-node
-- account.  The participant1 owner is stable by user ID, so this qualification
-- is deterministic.  The collision key prevents two aliases from collapsing
-- into one conversation silently.
INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `id`, `participant1_id`,
    lower(trim(CASE
      WHEN substr(trim(`participant2_handle`), 1, 1) = '@'
        THEN substr(trim(`participant2_handle`), 2)
      ELSE trim(`participant2_handle`)
    END)) AS `clean_handle`,
    (SELECT `local_domain` FROM `__identity_migration_context` WHERE `id` = 1) AS `local_domain`
  FROM `chat_conversations`
),
`addressed_rows` AS (
  SELECT *, CASE
    WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
    ELSE `clean_handle` || '@' || `local_domain`
  END AS `canonical_handle`
  FROM `clean_rows`
)
SELECT
  'chat_conversations', `id`, `canonical_handle`,
  substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1),
  'chat_conversations|' || `participant1_id` || '|' || `canonical_handle`
FROM `addressed_rows`
WHERE length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND instr(`canonical_handle`, '@') > 1;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'chat_conversations')
    = (SELECT count(*) FROM `chat_conversations`) THEN 1 ELSE 0
END;
--> statement-breakpoint

-- sender_handle is an unsigned query/display projection.  The encrypted
-- envelope and its signature remain byte-for-byte unchanged below.  A current
-- user row (matched by DID) is strongest; otherwise sender_node_domain, then
-- the documented NULL-is-local legacy meaning, supplies the home domain.
INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `message`.`id`,
    `message`.`sender_did`,
    `message`.`sender_node_domain`,
    `owner`.`handle` AS `owner_handle`,
    `owner`.`home_domain` AS `owner_domain`,
    lower(trim(CASE
      WHEN substr(trim(`message`.`sender_handle`), 1, 1) = '@'
        THEN substr(trim(`message`.`sender_handle`), 2)
      ELSE trim(`message`.`sender_handle`)
    END)) AS `clean_handle`,
    CASE
      WHEN `message`.`sender_node_domain` IS NULL
        THEN (SELECT `local_domain` FROM `__identity_migration_context` WHERE `id` = 1)
      ELSE lower(trim(`message`.`sender_node_domain`))
    END AS `fallback_domain`
  FROM `chat_messages` AS `message`
  LEFT JOIN `users` AS `owner` ON `owner`.`did` = `message`.`sender_did`
),
`addressed_rows` AS (
  SELECT
    *,
    CASE
      WHEN `owner_handle` IS NOT NULL THEN `owner_handle`
      WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle`
      ELSE `clean_handle` || '@' || `fallback_domain`
    END AS `canonical_handle`,
    CASE
      WHEN `owner_domain` IS NOT NULL THEN `owner_domain`
      WHEN instr(`clean_handle`, '@') > 0 THEN substr(`clean_handle`, instr(`clean_handle`, '@') + 1)
      ELSE `fallback_domain`
    END AS `home_domain`
  FROM `clean_rows`
)
SELECT 'chat_messages', `id`, `canonical_handle`, `home_domain`, NULL
FROM `addressed_rows`
WHERE `canonical_handle` IS NOT NULL
  AND length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND (`owner_handle` IS NULL OR instr(`clean_handle`, '@') = 0 OR `clean_handle` = `owner_handle`)
  AND (
    `owner_handle` IS NOT NULL
    OR `sender_node_domain` IS NULL
    OR instr(`clean_handle`, '@') = 0
    OR substr(`clean_handle`, instr(`clean_handle`, '@') + 1) = `fallback_domain`
  );
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'chat_messages')
    = (SELECT count(*) FROM `chat_messages`) THEN 1 ELSE 0
END;
--> statement-breakpoint

-- Remote E2EE rows should already be qualified.  A legacy bare projection is
-- accepted only when exactly one still-live verified registry pin for the same
-- DID supplies its address.  proof_action is never touched.
INSERT INTO `__identity_projection_plan` (
  `table_name`, `row_key`, `canonical_handle`, `home_domain`, `collision_key`
)
WITH `clean_rows` AS (
  SELECT
    `bundle`.`did`,
    lower(trim(CASE
      WHEN substr(trim(`bundle`.`handle`), 1, 1) = '@' THEN substr(trim(`bundle`.`handle`), 2)
      ELSE trim(`bundle`.`handle`)
    END)) AS `clean_handle`,
    (SELECT count(*) FROM `handle_registry` AS `pin`
      WHERE `pin`.`did` = `bundle`.`did`
        AND `pin`.`identity_verified` = 1
        AND `pin`.`deleted_at` IS NULL) AS `pin_count`,
    (SELECT `pin`.`handle` FROM `handle_registry` AS `pin`
      WHERE `pin`.`did` = `bundle`.`did`
        AND `pin`.`identity_verified` = 1
        AND `pin`.`deleted_at` IS NULL
      ORDER BY `pin`.`handle`
      LIMIT 1) AS `pinned_handle`
  FROM `e2ee_remote_key_bundles` AS `bundle`
),
`addressed_rows` AS (
  SELECT
    *,
    CASE WHEN instr(`clean_handle`, '@') > 0 THEN `clean_handle` ELSE `pinned_handle` END AS `canonical_handle`
  FROM `clean_rows`
)
SELECT
  'e2ee_remote_key_bundles', `did`, `canonical_handle`,
  substr(`canonical_handle`, instr(`canonical_handle`, '@') + 1),
  'e2ee_remote_key_bundles|' || `canonical_handle`
FROM `addressed_rows`
WHERE `canonical_handle` IS NOT NULL
  AND length(`clean_handle`) - length(replace(`clean_handle`, '@', '')) IN (0, 1)
  AND (instr(`clean_handle`, '@') > 0 OR `pin_count` = 1)
  AND (`pin_count` = 0 OR `pinned_handle` = `canonical_handle`);
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE
  WHEN (SELECT count(*) FROM `__identity_projection_plan` WHERE `table_name` = 'e2ee_remote_key_bundles')
    = (SELECT count(*) FROM `e2ee_remote_key_bundles`) THEN 1 ELSE 0
END;
--> statement-breakpoint

-- Apply only the precomputed plans.  No signed JSON, encrypted envelope,
-- signature, nonce, replay hash, or provenance column appears in these UPDATEs.
UPDATE `remote_follows`
SET `target_handle` = (
  SELECT `canonical_handle` FROM `__identity_projection_plan`
  WHERE `table_name` = 'remote_follows' AND `row_key` = `remote_follows`.`id`
);
--> statement-breakpoint
UPDATE `remote_followers`
SET `handle` = (
  SELECT `canonical_handle` FROM `__identity_projection_plan`
  WHERE `table_name` = 'remote_followers' AND `row_key` = `remote_followers`.`id`
)
WHERE `handle` IS NOT NULL;
--> statement-breakpoint
UPDATE `remote_posts`
SET
  `author_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_posts' AND `row_key` = `remote_posts`.`id`
  ),
  `node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_posts' AND `row_key` = `remote_posts`.`id`
  );
--> statement-breakpoint
UPDATE `remote_likes`
SET
  `actor_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_likes' AND `row_key` = `remote_likes`.`id`
  ),
  `actor_node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_likes' AND `row_key` = `remote_likes`.`id`
  );
--> statement-breakpoint
UPDATE `remote_reposts`
SET
  `actor_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_reposts' AND `row_key` = `remote_reposts`.`id`
  ),
  `actor_node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_reposts' AND `row_key` = `remote_reposts`.`id`
  );
--> statement-breakpoint
UPDATE `user_swarm_likes`
SET
  `author_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'user_swarm_likes' AND `row_key` = `user_swarm_likes`.`id`
  ),
  `node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'user_swarm_likes' AND `row_key` = `user_swarm_likes`.`id`
  );
--> statement-breakpoint
UPDATE `user_swarm_reposts`
SET
  `author_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'user_swarm_reposts' AND `row_key` = `user_swarm_reposts`.`id`
  ),
  `node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'user_swarm_reposts' AND `row_key` = `user_swarm_reposts`.`id`
  );
--> statement-breakpoint
UPDATE `notifications`
SET
  `actor_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'notifications' AND `row_key` = `notifications`.`id`
  ),
  `actor_node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'notifications' AND `row_key` = `notifications`.`id`
  );
--> statement-breakpoint
UPDATE `mention_deliveries`
SET
  `target_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'mention_deliveries' AND `row_key` = `mention_deliveries`.`id`
  ),
  `target_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'mention_deliveries' AND `row_key` = `mention_deliveries`.`id`
  );
--> statement-breakpoint
UPDATE `remote_follow_sync_states`
SET
  `target_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_follow_sync_states'
      AND `row_key` = `remote_follow_sync_states`.`target_handle`
  ),
  `node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'remote_follow_sync_states'
      AND `row_key` = `remote_follow_sync_states`.`target_handle`
  );
--> statement-breakpoint
UPDATE `chat_conversations`
SET `participant2_handle` = (
  SELECT `canonical_handle` FROM `__identity_projection_plan`
  WHERE `table_name` = 'chat_conversations' AND `row_key` = `chat_conversations`.`id`
);
--> statement-breakpoint
UPDATE `chat_messages`
SET
  `sender_handle` = (
    SELECT `canonical_handle` FROM `__identity_projection_plan`
    WHERE `table_name` = 'chat_messages' AND `row_key` = `chat_messages`.`id`
  ),
  `sender_node_domain` = (
    SELECT `home_domain` FROM `__identity_projection_plan`
    WHERE `table_name` = 'chat_messages' AND `row_key` = `chat_messages`.`id`
  );
--> statement-breakpoint
UPDATE `e2ee_remote_key_bundles`
SET `handle` = (
  SELECT `canonical_handle` FROM `__identity_projection_plan`
  WHERE `table_name` = 'e2ee_remote_key_bundles' AND `row_key` = `e2ee_remote_key_bundles`.`did`
);
--> statement-breakpoint

-- Typing indicators expire after ten seconds and carry no durable user data.
-- Clearing them avoids manufacturing origin for a stale, unqualified row.
DELETE FROM `chat_typing_indicators`;
--> statement-breakpoint

-- Reinstall the durable content-change triggers with explicit ownership.
CREATE TRIGGER `swarm_post_changes_posts_insert`
AFTER INSERT ON `posts`
WHEN NEW.`is_removed` = 0
  AND NEW.`reply_to_id` IS NULL
  AND NEW.`swarm_reply_to_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` = NEW.`user_id`
      AND `is_local_account` = 1
      AND `is_suspended` = 0
  )
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(NEW.`repost_of_id`, NEW.`id`), `sequence`, 'upsert', unixepoch()
  FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_posts_delete`
BEFORE DELETE ON `posts`
WHEN OLD.`reply_to_id` IS NULL
  AND OLD.`swarm_reply_to_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` = OLD.`user_id` AND `is_local_account` = 1
  )
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(OLD.`repost_of_id`, OLD.`id`), `sequence`,
    CASE WHEN OLD.`repost_of_id` IS NULL THEN 'delete' ELSE 'upsert' END,
    unixepoch()
  FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_posts_update`
AFTER UPDATE OF `content`, `repost_of_id`, `likes_count`, `reposts_count`, `replies_count`,
  `is_nsfw`, `is_removed`, `link_preview_url`, `link_preview_title`,
  `link_preview_description`, `link_preview_image`, `link_preview_type`,
  `link_preview_video_url`, `link_preview_media_json` ON `posts`
WHEN OLD.`reply_to_id` IS NULL AND OLD.`swarm_reply_to_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `users`
    WHERE `id` = OLD.`user_id` AND `is_local_account` = 1
  )
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(OLD.`repost_of_id`, OLD.`id`), `sequence`,
    CASE WHEN EXISTS (
      SELECT 1 FROM `posts` AS `origin`
      INNER JOIN `users` AS `author` ON `author`.`id` = `origin`.`user_id`
      WHERE `origin`.`id` = coalesce(OLD.`repost_of_id`, OLD.`id`)
        AND `origin`.`is_removed` = 0
        AND `origin`.`reply_to_id` IS NULL
        AND `origin`.`swarm_reply_to_id` IS NULL
        AND `author`.`is_local_account` = 1
        AND `author`.`is_suspended` = 0
    ) THEN 'upsert' ELSE 'delete' END,
    unixepoch()
  FROM `swarm_content_clock` WHERE `id` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;

  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1
  WHERE `id` = 1 AND coalesce(NEW.`repost_of_id`, NEW.`id`) <> coalesce(OLD.`repost_of_id`, OLD.`id`);
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(NEW.`repost_of_id`, NEW.`id`), `sequence`,
    CASE WHEN EXISTS (
      SELECT 1 FROM `posts` AS `origin`
      INNER JOIN `users` AS `author` ON `author`.`id` = `origin`.`user_id`
      WHERE `origin`.`id` = coalesce(NEW.`repost_of_id`, NEW.`id`)
        AND `origin`.`is_removed` = 0
        AND `origin`.`reply_to_id` IS NULL
        AND `origin`.`swarm_reply_to_id` IS NULL
        AND `author`.`is_local_account` = 1
        AND `author`.`is_suspended` = 0
    ) THEN 'upsert' ELSE 'delete' END,
    unixepoch()
  FROM `swarm_content_clock`
  WHERE `id` = 1 AND coalesce(NEW.`repost_of_id`, NEW.`id`) <> coalesce(OLD.`repost_of_id`, OLD.`id`)
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`,
    `change_type` = excluded.`change_type`,
    `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_users_update`
AFTER UPDATE OF `handle`, `username`, `home_domain`, `is_local_account`,
  `display_name`, `avatar_url`, `is_nsfw`, `is_suspended` ON `users`
WHEN (OLD.`is_local_account` = 1 OR NEW.`is_local_account` = 1)
  AND (
    OLD.`handle` IS NOT NEW.`handle`
    OR OLD.`username` IS NOT NEW.`username`
    OR OLD.`home_domain` IS NOT NEW.`home_domain`
    OR OLD.`is_local_account` IS NOT NEW.`is_local_account`
    OR OLD.`display_name` IS NOT NEW.`display_name`
    OR OLD.`avatar_url` IS NOT NEW.`avatar_url`
    OR OLD.`is_nsfw` IS NOT NEW.`is_nsfw`
    OR OLD.`is_suspended` IS NOT NEW.`is_suspended`
  )
BEGIN
  UPDATE `posts` SET `content` = `content`
  WHERE `user_id` = NEW.`id`
    AND `reply_to_id` IS NULL
    AND `swarm_reply_to_id` IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_media_insert`
AFTER INSERT ON `media`
WHEN NEW.`post_id` IS NOT NULL
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = NEW.`post_id` AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`is_local_account` = 1
    AND `author`.`is_suspended` = 0
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_media_delete`
AFTER DELETE ON `media`
WHEN OLD.`post_id` IS NOT NULL
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = OLD.`post_id` AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`is_local_account` = 1
    AND `author`.`is_suspended` = 0
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `swarm_post_changes_media_update`
AFTER UPDATE OF `post_id`, `url`, `alt_text`, `mime_type`, `width`, `height` ON `media`
BEGIN
  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1 WHERE `id` = 1;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = OLD.`post_id` AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`is_local_account` = 1
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;

  UPDATE `swarm_content_clock` SET `sequence` = `sequence` + 1
  WHERE `id` = 1 AND NEW.`post_id` IS NOT OLD.`post_id`;
  INSERT INTO `swarm_post_changes` (`story_id`, `sequence`, `change_type`, `changed_at`)
  SELECT coalesce(`post`.`repost_of_id`, `post`.`id`), `clock`.`sequence`, 'upsert', unixepoch()
  FROM `posts` AS `post`
  INNER JOIN `users` AS `author` ON `author`.`id` = `post`.`user_id`
  INNER JOIN `swarm_content_clock` AS `clock` ON `clock`.`id` = 1
  WHERE `post`.`id` = NEW.`post_id` AND NEW.`post_id` IS NOT OLD.`post_id`
    AND `post`.`is_removed` = 0
    AND `post`.`reply_to_id` IS NULL AND `post`.`swarm_reply_to_id` IS NULL
    AND `author`.`is_local_account` = 1
    AND `author`.`is_suspended` = 0
  ON CONFLICT (`story_id`) DO UPDATE SET
    `sequence` = excluded.`sequence`, `change_type` = 'upsert', `changed_at` = excluded.`changed_at`;
END;
--> statement-breakpoint

-- ALTER TABLE cannot strengthen these two legacy nullable columns without
-- rebuilding FK parents that also carry immutable encrypted payloads.  All
-- existing rows are populated above; these guards make the schema-level
-- not-null contract effective for every future write.
CREATE TRIGGER `notifications_actor_identity_insert_guard`
BEFORE INSERT ON `notifications`
WHEN NEW.`actor_node_domain` IS NULL
  OR NEW.`actor_handle` <> lower(NEW.`actor_handle`)
  OR NEW.`actor_node_domain` <> lower(NEW.`actor_node_domain`)
  OR length(NEW.`actor_handle`) - length(replace(NEW.`actor_handle`, '@', '')) <> 1
  OR instr(NEW.`actor_handle`, '@') <= 1
  OR length(NEW.`actor_node_domain`) = 0
  OR instr(NEW.`actor_node_domain`, '@') <> 0
  OR instr(NEW.`actor_node_domain`, '/') <> 0
  OR NEW.`actor_node_domain` = 'node.synapsis.social'
  OR substr(NEW.`actor_handle`, instr(NEW.`actor_handle`, '@') + 1) <> NEW.`actor_node_domain`
BEGIN
  SELECT RAISE(ABORT, 'notification actor identity must be a canonical qualified address');
END;
--> statement-breakpoint
CREATE TRIGGER `notifications_actor_identity_update_guard`
BEFORE UPDATE OF `actor_handle`, `actor_node_domain` ON `notifications`
WHEN NEW.`actor_node_domain` IS NULL
  OR NEW.`actor_handle` <> lower(NEW.`actor_handle`)
  OR NEW.`actor_node_domain` <> lower(NEW.`actor_node_domain`)
  OR length(NEW.`actor_handle`) - length(replace(NEW.`actor_handle`, '@', '')) <> 1
  OR instr(NEW.`actor_handle`, '@') <= 1
  OR length(NEW.`actor_node_domain`) = 0
  OR instr(NEW.`actor_node_domain`, '@') <> 0
  OR instr(NEW.`actor_node_domain`, '/') <> 0
  OR NEW.`actor_node_domain` = 'node.synapsis.social'
  OR substr(NEW.`actor_handle`, instr(NEW.`actor_handle`, '@') + 1) <> NEW.`actor_node_domain`
BEGIN
  SELECT RAISE(ABORT, 'notification actor identity must be a canonical qualified address');
END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_sender_identity_insert_guard`
BEFORE INSERT ON `chat_messages`
WHEN NEW.`sender_node_domain` IS NULL
  OR NEW.`sender_handle` <> lower(NEW.`sender_handle`)
  OR NEW.`sender_node_domain` <> lower(NEW.`sender_node_domain`)
  OR length(NEW.`sender_handle`) - length(replace(NEW.`sender_handle`, '@', '')) <> 1
  OR instr(NEW.`sender_handle`, '@') <= 1
  OR length(NEW.`sender_node_domain`) = 0
  OR instr(NEW.`sender_node_domain`, '@') <> 0
  OR instr(NEW.`sender_node_domain`, '/') <> 0
  OR NEW.`sender_node_domain` = 'node.synapsis.social'
  OR substr(NEW.`sender_handle`, instr(NEW.`sender_handle`, '@') + 1) <> NEW.`sender_node_domain`
BEGIN
  SELECT RAISE(ABORT, 'chat sender identity must be a canonical qualified address');
END;
--> statement-breakpoint
CREATE TRIGGER `chat_messages_sender_identity_update_guard`
BEFORE UPDATE OF `sender_handle`, `sender_node_domain` ON `chat_messages`
WHEN NEW.`sender_node_domain` IS NULL
  OR NEW.`sender_handle` <> lower(NEW.`sender_handle`)
  OR NEW.`sender_node_domain` <> lower(NEW.`sender_node_domain`)
  OR length(NEW.`sender_handle`) - length(replace(NEW.`sender_handle`, '@', '')) <> 1
  OR instr(NEW.`sender_handle`, '@') <= 1
  OR length(NEW.`sender_node_domain`) = 0
  OR instr(NEW.`sender_node_domain`, '@') <> 0
  OR instr(NEW.`sender_node_domain`, '/') <> 0
  OR NEW.`sender_node_domain` = 'node.synapsis.social'
  OR substr(NEW.`sender_handle`, instr(NEW.`sender_handle`, '@') + 1) <> NEW.`sender_node_domain`
BEGIN
  SELECT RAISE(ABORT, 'chat sender identity must be a canonical qualified address');
END;
--> statement-breakpoint

-- Final all-or-nothing invariants.  Every non-null account projection is now
-- qualified and every explicit domain agrees with the address suffix.
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM `users`
  WHERE `handle` <> `username` || '@' || `home_domain`
    OR `handle` <> lower(`handle`)
    OR `username` <> lower(`username`)
    OR `home_domain` <> lower(`home_domain`)
    OR `is_local_account` NOT IN (0, 1)
    OR `is_local_account` <> CASE
      WHEN `node_id` IS NULL AND `home_domain` =
        (SELECT `local_domain` FROM `__identity_migration_context` WHERE `id` = 1)
      THEN 1 ELSE 0
    END
) THEN 1 ELSE 0 END;
--> statement-breakpoint
INSERT INTO `__identity_cutover_guard` (`ok`)
SELECT CASE WHEN
  (SELECT count(*) FROM `handle_registry`
    WHERE length(`handle`) - length(replace(`handle`, '@', '')) <> 1
      OR `handle` <> lower(`handle`)
      OR `node_domain` <> lower(`node_domain`)
      OR substr(`handle`, instr(`handle`, '@') + 1) <> `node_domain`)
  + (SELECT count(*) FROM `swarm_account_tombstones`
    WHERE `handle` <> `username` || '@' || `home_domain`
      OR `home_domain` <> (SELECT `local_domain` FROM `__identity_migration_context` WHERE `id` = 1))
  + (SELECT count(*) FROM `remote_follows`
    WHERE length(`target_handle`) - length(replace(`target_handle`, '@', '')) <> 1)
  + (SELECT count(*) FROM `remote_followers`
    WHERE `handle` IS NOT NULL
      AND length(`handle`) - length(replace(`handle`, '@', '')) <> 1)
  + (SELECT count(*) FROM `remote_posts`
    WHERE `node_domain` IS NULL
      OR substr(`author_handle`, instr(`author_handle`, '@') + 1) <> `node_domain`)
  + (SELECT count(*) FROM `remote_likes`
    WHERE substr(`actor_handle`, instr(`actor_handle`, '@') + 1) <> `actor_node_domain`)
  + (SELECT count(*) FROM `remote_reposts`
    WHERE substr(`actor_handle`, instr(`actor_handle`, '@') + 1) <> `actor_node_domain`)
  + (SELECT count(*) FROM `user_swarm_likes`
    WHERE substr(`author_handle`, instr(`author_handle`, '@') + 1) <> `node_domain`)
  + (SELECT count(*) FROM `user_swarm_reposts`
    WHERE substr(`author_handle`, instr(`author_handle`, '@') + 1) <> `node_domain`)
  + (SELECT count(*) FROM `notifications`
    WHERE `actor_node_domain` IS NULL
      OR substr(`actor_handle`, instr(`actor_handle`, '@') + 1) <> `actor_node_domain`)
  + (SELECT count(*) FROM `mention_deliveries`
    WHERE substr(`target_handle`, instr(`target_handle`, '@') + 1) <> `target_domain`)
  + (SELECT count(*) FROM `remote_follow_sync_states`
    WHERE substr(`target_handle`, instr(`target_handle`, '@') + 1) <> `node_domain`)
  + (SELECT count(*) FROM `chat_conversations`
    WHERE length(`participant2_handle`) - length(replace(`participant2_handle`, '@', '')) <> 1)
  + (SELECT count(*) FROM `chat_messages`
    WHERE `sender_node_domain` IS NULL
      OR substr(`sender_handle`, instr(`sender_handle`, '@') + 1) <> `sender_node_domain`)
  + (SELECT count(*) FROM `e2ee_remote_key_bundles`
    WHERE length(`handle`) - length(replace(`handle`, '@', '')) <> 1)
  + (SELECT count(*) FROM `chat_typing_indicators`)
  = 0 THEN 1 ELSE 0 END;
--> statement-breakpoint

DROP TABLE `__identity_migration_context`;
--> statement-breakpoint
DROP TABLE `__identity_projection_plan`;
--> statement-breakpoint
DROP TABLE `__identity_tombstone_plan`;
--> statement-breakpoint
DROP TABLE `__identity_registry_plan`;
--> statement-breakpoint
DROP TABLE `__identity_user_address_plan`;
--> statement-breakpoint
DROP TABLE `__identity_cutover_guard`;
