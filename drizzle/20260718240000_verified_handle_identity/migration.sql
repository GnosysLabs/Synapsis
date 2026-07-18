ALTER TABLE `handle_registry`
ADD COLUMN `identity_verified` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Bare handles are owned by this node. Existing qualified remote rows came
-- from legacy directory discovery and must remain unverified until that user
-- supplies a valid self-certifying action proof.
UPDATE `handle_registry`
SET `identity_verified` = true
WHERE instr(`handle`, '@') = 0;
--> statement-breakpoint
-- One signing identity cannot materialize as multiple handles on the same
-- authoritative node. Unverified directory hints remain free to overlap.
CREATE UNIQUE INDEX `handle_registry_verified_node_did_unique_idx`
ON `handle_registry` (`node_domain`, `did`)
WHERE `identity_verified` = true;
