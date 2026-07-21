import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/tursodatabase/migrator';
import { closeDb, db } from '../src/db';
import { reconcilePostSearchIndex } from '../src/lib/search/post-index';
import { reconcileBlockedNodeQuarantines } from '../src/lib/swarm/node-blocklist';
import {
  getCanonicalSwarmSeedDomain,
  normalizeNodeDomain,
} from '../src/lib/swarm/node-domain';
import { isValidNodeDomain } from '../src/lib/utils/federation';

interface DuplicateIdentityRow {
  field: 'did' | 'handle';
  value: string;
  duplicateCount: number;
}

interface ForeignKeyViolationRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface TableColumnRow {
  name: string;
}

interface CountRow {
  count: number;
}

interface NodeIdentityRow {
  id: string;
  domain: string;
}

interface LegacyUserIdentityRow {
  id: string;
  did: string;
  handle: string;
  nodeId: string | null;
}

interface ProjectionIssueRow {
  rowKey: string;
  reason: string;
}

const IDENTITY_MIGRATION_CONTEXT_TABLE = '__identity_migration_context';
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

async function tableExists(name: string): Promise<boolean> {
  const rows = await db.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ${name}
    LIMIT 1
  `);
  return rows.length === 1;
}

async function tableColumns(name: string): Promise<Set<string>> {
  if (!/^[a-z0-9_]+$/i.test(name)) {
    throw new Error(`Unsafe schema identifier: ${name}`);
  }
  const rows = await db.all<TableColumnRow>(sql.raw(`PRAGMA table_info("${name}")`));
  return new Set(rows.map((row) => row.name));
}

function cleanLegacyHandle(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).toLowerCase();
}

function canonicalIdentityDomain(value: string): string {
  const normalized = normalizeNodeDomain(value).replace(/\.$/, '');
  return getCanonicalSwarmSeedDomain(normalized) ?? normalized;
}

function parseQualifiedAddress(value: string): { username: string; homeDomain: string } | null {
  const clean = cleanLegacyHandle(value);
  const separator = clean.indexOf('@');
  if (separator <= 0 || separator !== clean.lastIndexOf('@')) return null;

  const username = clean.slice(0, separator);
  const homeDomain = canonicalIdentityDomain(clean.slice(separator + 1));
  if (!USERNAME_PATTERN.test(username) || !isValidNodeDomain(homeDomain)) return null;
  return { username, homeDomain };
}

async function prepareIdentityMigrationContext(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_NODE_DOMAIN
    || process.env.NODE_DOMAIN
    || 'localhost:43821';
  const localDomain = canonicalIdentityDomain(configured);
  if (!isValidNodeDomain(localDomain)) {
    throw new Error(
      `Identity migration requires a valid NEXT_PUBLIC_NODE_DOMAIN or NODE_DOMAIN; received ${JSON.stringify(configured)}`,
    );
  }

  await db.run(sql.raw(`
    CREATE TABLE IF NOT EXISTS "${IDENTITY_MIGRATION_CONTEXT_TABLE}" (
      id integer PRIMARY KEY CHECK (id = 1),
      local_domain text NOT NULL,
      prepared_at integer NOT NULL
    )
  `));
  await db.run(sql.raw(`DELETE FROM "${IDENTITY_MIGRATION_CONTEXT_TABLE}"`));
  await db.run(sql`
    INSERT INTO ${sql.identifier(IDENTITY_MIGRATION_CONTEXT_TABLE)}
      (id, local_domain, prepared_at)
    VALUES (1, ${localDomain}, unixepoch())
  `);

  return localDomain;
}

async function assertLegacyIdentityCutoverReady(localDomain: string): Promise<void> {
  if (!await tableExists('users')) return;

  const [{ count: userCount = 0 } = { count: 0 }] = await db.all<CountRow>(
    sql.raw('SELECT count(*) AS count FROM users'),
  );
  if (Number(userCount) === 0) return;

  if (!await tableExists('nodes')) {
    throw new Error('Identity migration cannot attribute existing users because the nodes table is missing');
  }

  const nodeRows = await db.all<NodeIdentityRow>(sql.raw(
    'SELECT id, domain FROM nodes ORDER BY id',
  ));
  const normalizedNodes = nodeRows.map((row) => ({
    ...row,
    normalizedDomain: canonicalIdentityDomain(row.domain),
  }));
  const localMatches = normalizedNodes.filter((row) => row.normalizedDomain === localDomain);
  if (localMatches.length !== 1) {
    throw new Error(
      `Identity migration requires exactly one nodes.domain matching ${localDomain}; found ${localMatches.length}`,
    );
  }

  const columns = await tableColumns('users');
  if (columns.has('username') && columns.has('home_domain') && columns.has('is_local_account')) {
    const invalid = await db.all<{ id: string; handle: string }>(sql.raw(`
      SELECT id, handle FROM users
      WHERE handle <> username || '@' || home_domain
        OR handle <> lower(handle)
        OR username <> lower(username)
        OR home_domain <> lower(home_domain)
        OR is_local_account NOT IN (0, 1)
        OR is_local_account <> CASE
          WHEN node_id IS NULL AND home_domain = (
            SELECT local_domain FROM __identity_migration_context WHERE id = 1
          ) THEN 1 ELSE 0
        END
      LIMIT 20
    `));
    if (invalid.length > 0) {
      throw new Error(
        `Canonical identity preflight failed for migrated users: ${invalid.map((row) => `${row.id}:${row.handle}`).join(', ')}`,
      );
    }
    return;
  }

  const users = await db.all<LegacyUserIdentityRow>(sql.raw(`
    SELECT id, did, handle, node_id AS nodeId
    FROM users
    ORDER BY id
  `));
  const nodeDomains = new Map(normalizedNodes.map((row) => [row.id, row.normalizedDomain]));
  const canonicalOwners = new Map<string, LegacyUserIdentityRow>();
  const problems: string[] = [];

  for (const user of users) {
    const clean = cleanLegacyHandle(user.handle);
    const qualified = parseQualifiedAddress(clean);
    const separatorCount = [...clean].filter((character) => character === '@').length;

    let username: string;
    let homeDomain: string | undefined;
    if (qualified) {
      username = qualified.username;
      homeDomain = qualified.homeDomain;
      const recordedDomain = user.nodeId ? nodeDomains.get(user.nodeId) : undefined;
      if (recordedDomain && recordedDomain !== homeDomain) {
        problems.push(`${user.id}: handle domain ${homeDomain} disagrees with nodes.domain ${recordedDomain}`);
        continue;
      }
    } else if (separatorCount === 0 && USERNAME_PATTERN.test(clean)) {
      username = clean;
      homeDomain = user.nodeId ? nodeDomains.get(user.nodeId) : localDomain;
      if (!homeDomain) {
        problems.push(`${user.id}: bare cached handle has no attributable nodes.domain`);
        continue;
      }
    } else {
      problems.push(`${user.id}: malformed legacy handle ${JSON.stringify(user.handle)}`);
      continue;
    }

    if (!isValidNodeDomain(homeDomain)) {
      problems.push(`${user.id}: invalid home domain ${JSON.stringify(homeDomain)}`);
      continue;
    }

    const canonical = `${username}@${homeDomain}`;
    const existing = canonicalOwners.get(canonical);
    if (existing && existing.id !== user.id) {
      problems.push(
        `${user.id}: canonical address ${canonical} collides with user ${existing.id}`,
      );
      continue;
    }
    canonicalOwners.set(canonical, user);
  }

  if (problems.length > 0) {
    throw new Error(
      `Identity migration preflight failed; no data was changed: ${problems.slice(0, 20).join('; ')}`,
    );
  }
}

async function assertLegacyProjectionAttribution(): Promise<void> {
  const issues: string[] = [];
  const checks: Array<{ table: string; query: string }> = [
    {
      table: 'remote_follows',
      query: `
        SELECT id AS rowKey,
          'target_handle has no authoritative domain column' AS reason
        FROM remote_follows
        WHERE length(lower(trim(ltrim(target_handle, '@'))))
          - length(replace(lower(trim(ltrim(target_handle, '@'))), '@', '')) <> 1
        LIMIT 20
      `,
    },
    {
      table: 'remote_followers',
      query: `
        SELECT id AS rowKey,
          'non-null handle has no authoritative qualified address' AS reason
        FROM remote_followers
        WHERE handle IS NOT NULL
          AND length(lower(trim(ltrim(handle, '@'))))
            - length(replace(lower(trim(ltrim(handle, '@'))), '@', '')) <> 1
        LIMIT 20
      `,
    },
    {
      table: 'remote_posts',
      query: `
        SELECT id AS rowKey,
          'bare author_handle is missing node_domain' AS reason
        FROM remote_posts
        WHERE length(lower(trim(ltrim(author_handle, '@'))))
            - length(replace(lower(trim(ltrim(author_handle, '@'))), '@', '')) = 0
          AND node_domain IS NULL
        LIMIT 20
      `,
    },
    {
      table: 'e2ee_remote_key_bundles',
      query: `
        SELECT bundle.did AS rowKey,
          'bare E2EE handle lacks exactly one live verified registry pin' AS reason
        FROM e2ee_remote_key_bundles AS bundle
        WHERE length(lower(trim(ltrim(bundle.handle, '@'))))
            - length(replace(lower(trim(ltrim(bundle.handle, '@'))), '@', '')) = 0
          AND (
            SELECT count(*) FROM handle_registry AS pin
            WHERE pin.did = bundle.did
              AND pin.identity_verified = 1
              AND pin.deleted_at IS NULL
          ) <> 1
        LIMIT 20
      `,
    },
  ];

  for (const check of checks) {
    if (!await tableExists(check.table)) continue;
    const rows = await db.all<ProjectionIssueRow>(sql.raw(check.query));
    issues.push(...rows.map((row) => `${check.table}[${row.rowKey}]: ${row.reason}`));
    if (issues.length >= 20) break;
  }

  if (issues.length > 0) {
    throw new Error(
      `Identity projection preflight found unattributable rows; no data was changed: ${issues.slice(0, 20).join('; ')}`,
    );
  }
}

async function removeIdentityMigrationContext(): Promise<void> {
  try {
    await db.run(sql.raw(`DROP TABLE IF EXISTS "${IDENTITY_MIGRATION_CONTEXT_TABLE}"`));
  } catch (error) {
    console.error('Failed to remove identity migration context:', error);
  }
}

async function assertIdentityUniqueness(): Promise<void> {
  const tables = await db.all<{ name: string }>(sql.raw(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users' LIMIT 1",
  ));
  if (tables.length === 0) return;

  const duplicates = await db.all<DuplicateIdentityRow>(sql.raw(`
    SELECT 'did' AS field, did AS value, COUNT(*) AS duplicateCount
    FROM users
    GROUP BY did
    HAVING COUNT(*) > 1
    UNION ALL
    SELECT 'handle' AS field, handle AS value, COUNT(*) AS duplicateCount
    FROM users
    GROUP BY handle
    HAVING COUNT(*) > 1
    LIMIT 20
  `));
  if (duplicates.length === 0) return;

  const sample = duplicates
    .map((row) => `${row.field}=${JSON.stringify(row.value)} (${row.duplicateCount} rows)`)
    .join(', ');
  throw new Error(
    `Database identity preflight failed: duplicate users must be resolved before migration: ${sample}`,
  );
}

async function assertForeignKeyIntegrity(): Promise<void> {
  const violations = await db.all<ForeignKeyViolationRow>(sql.raw('PRAGMA foreign_key_check'));
  if (violations.length === 0) return;

  const sample = violations
    .slice(0, 20)
    .map((row) => `${row.table}[rowid=${row.rowid ?? 'unknown'}] -> ${row.parent} (fk ${row.fkid})`)
    .join(', ');
  throw new Error(`Database foreign-key check failed after migration: ${sample}`);
}

async function backfillPostSearchIndex(): Promise<void> {
  let indexed = 0;
  while (true) {
    const batchCount = await reconcilePostSearchIndex(500);
    if (batchCount === 0) break;
    indexed += batchCount;
    if (indexed % 10_000 === 0) {
      console.log(`Indexed ${indexed} existing posts for search...`);
    }
  }
  if (indexed > 0) console.log(`Indexed ${indexed} existing posts for search.`);
}

async function main() {
  let foreignKeysDisabled = false;
  try {
    const localDomain = await prepareIdentityMigrationContext();
    await assertIdentityUniqueness();
    await assertLegacyIdentityCutoverReady(localDomain);
    await assertLegacyProjectionAttribution();

    // Drizzle wraps all pending SQLite migrations in one transaction. SQLite
    // ignores PRAGMA foreign_keys changes made inside a transaction, so disable
    // enforcement here, before migrate(), for the ID-preserving users rebuild.
    // The post-migration foreign_key_check remains the acceptance boundary.
    await db.run(sql.raw('PRAGMA foreign_keys = OFF'));
    foreignKeysDisabled = true;
    const result = await migrate(db, { migrationsFolder: './drizzle' });

    if (result) {
      throw new Error(`Database migration failed: ${JSON.stringify(result)}`);
    }

    await db.run(sql.raw('PRAGMA foreign_keys = ON'));
    foreignKeysDisabled = false;
    const quarantine = await reconcileBlockedNodeQuarantines();
    if (quarantine.failed > 0) {
      console.warn(
        `Blocked-node quarantine is still pending for ${quarantine.failed} node(s); the runtime reconciler will retry.`,
      );
    }
    await backfillPostSearchIndex();
    await assertForeignKeyIntegrity();
    await db.run(sql.raw('PRAGMA wal_checkpoint(TRUNCATE)'));
    console.log('Database migrations are up to date.');
  } finally {
    if (foreignKeysDisabled) {
      try {
        await db.run(sql.raw('PRAGMA foreign_keys = ON'));
      } catch (error) {
        console.error('Failed to restore SQLite foreign-key enforcement:', error);
      }
    }
    await removeIdentityMigrationContext();
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
