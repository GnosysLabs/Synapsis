UPDATE `swarm_content_sync_states`
SET
  `failures` = 0,
  `next_attempt_at` = unixepoch(),
  `lease_owner` = NULL,
  `lease_expires_at` = NULL,
  `last_error` = NULL,
  `updated_at` = unixepoch();
