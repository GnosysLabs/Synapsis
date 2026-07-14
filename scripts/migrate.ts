import { migrate } from 'drizzle-orm/tursodatabase/migrator';
import { db } from '../src/db';

async function main() {
  const result = await migrate(db, { migrationsFolder: './drizzle' });

  if (result) {
    throw new Error(`Database migration failed: ${JSON.stringify(result)}`);
  }

  console.log('Database migrations are up to date.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
