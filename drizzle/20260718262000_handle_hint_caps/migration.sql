CREATE TRIGGER IF NOT EXISTS `handle_registry_unverified_node_cap`
BEFORE INSERT ON `handle_registry`
WHEN NEW.`identity_verified` = 0
  AND (
    SELECT count(*)
    FROM `handle_registry`
    WHERE `identity_verified` = 0
      AND `node_domain` = NEW.`node_domain`
  ) >= 200
BEGIN
  SELECT RAISE(IGNORE);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `handle_registry_unverified_global_cap`
BEFORE INSERT ON `handle_registry`
WHEN NEW.`identity_verified` = 0
  AND (
    SELECT count(*)
    FROM `handle_registry`
    WHERE `identity_verified` = 0
  ) >= 5000
BEGIN
  SELECT RAISE(IGNORE);
END;
