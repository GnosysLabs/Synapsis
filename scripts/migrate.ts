import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/tursodatabase/migrator';
import { closeDb, db } from '../src/db';
import { reconcilePostSearchIndex } from '../src/lib/search/post-index';

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
  try {
    await assertIdentityUniqueness();
    const result = await migrate(db, { migrationsFolder: './drizzle' });

    if (result) {
      throw new Error(`Database migration failed: ${JSON.stringify(result)}`);
    }

    await backfillPostSearchIndex();
    await assertForeignKeyIntegrity();
    await db.run(sql.raw('PRAGMA wal_checkpoint(TRUNCATE)'));
    console.log('Database migrations are up to date.');
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
