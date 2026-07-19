-- The verified-handle upgrade assumed every legacy bare handle belonged to
-- this node. Legacy gossip also stored remote accounts as bare handles, so
-- that upgrade accidentally promoted remote directory hints into identity
-- pins. Keep bare pins only when their authoritative domain is this database's
-- local node.
UPDATE `handle_registry`
SET
  `identity_verified` = false,
  `updated_at` = unixepoch()
WHERE `identity_verified` = true
  AND instr(`handle`, '@') = 0
  AND NOT EXISTS (
    SELECT 1
    FROM `nodes`
    WHERE lower(`nodes`.`domain`) = lower(`handle_registry`.`node_domain`)
  );
--> statement-breakpoint
-- E2EE bundle proofs are signed by the account's self-certifying DID. They are
-- durable cryptographic evidence that the canonical qualified alias was
-- already verified before the bad migration. Restore only those pins; every
-- other remote hint remains unverified until its next signed actor action.
UPDATE `handle_registry`
SET
  `identity_verified` = true,
  `updated_at` = unixepoch()
WHERE `identity_verified` = false
  AND `deleted_at` IS NULL
  AND instr(`handle`, '@') > 0
  AND EXISTS (
    SELECT 1
    FROM `e2ee_remote_key_bundles` AS `bundle`
    WHERE lower(ltrim(`bundle`.`handle`, '@')) = lower(ltrim(`handle_registry`.`handle`, '@'))
      AND `bundle`.`did` = `handle_registry`.`did`
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `handle_registry` AS `verified_owner`
    WHERE `verified_owner`.`node_domain` = `handle_registry`.`node_domain`
      AND `verified_owner`.`did` = `handle_registry`.`did`
      AND `verified_owner`.`identity_verified` = true
      AND `verified_owner`.`handle` <> `handle_registry`.`handle`
  );
