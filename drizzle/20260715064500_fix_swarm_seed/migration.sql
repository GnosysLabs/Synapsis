DELETE FROM `swarm_seeds`
WHERE `domain` = 'node.synapsis.social'
  AND EXISTS (
    SELECT 1 FROM `swarm_seeds` AS `canonical_seed`
    WHERE `canonical_seed`.`domain` = 'synapsis.social'
  );
--> statement-breakpoint
UPDATE `swarm_seeds`
SET
  `domain` = 'synapsis.social',
  `consecutive_failures` = 0
WHERE `domain` = 'node.synapsis.social';
