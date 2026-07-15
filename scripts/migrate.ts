import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/tursodatabase/migrator';
import { closeDb, db } from '../src/db';

async function main() {
  try {
    const result = await migrate(db, { migrationsFolder: './drizzle' });

    if (result) {
      throw new Error(`Database migration failed: ${JSON.stringify(result)}`);
    }

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
