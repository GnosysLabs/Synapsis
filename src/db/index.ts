import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { relations } from './relations';

const configuredPath = process.env.DATABASE_PATH || './data/synapsis.db';
const databasePath = configuredPath === ':memory:' ? configuredPath : resolve(configuredPath);

if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
}

const createDb = () => drizzle(databasePath, { relations });
type SynapsisDatabase = ReturnType<typeof createDb>;

const globalForDb = globalThis as typeof globalThis & {
    synapsisDb?: SynapsisDatabase;
};

export const db = globalForDb.synapsisDb ?? createDb();

globalForDb.synapsisDb = db;

export async function closeDb(): Promise<void> {
    if (!globalForDb.synapsisDb) {
        return;
    }

    await globalForDb.synapsisDb.$client.close();
    delete globalForDb.synapsisDb;
}

// Embedded Turso is always available; DATABASE_PATH only changes its location.
export const isDbAvailable = () => true;

// Export schema for use elsewhere
export * from './schema';
