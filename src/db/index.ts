import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { relations } from './relations';

const configuredPath = process.env.DATABASE_PATH || './data/synapsis.db';
const databasePath = configuredPath === ':memory:' ? configuredPath : resolve(configuredPath);

if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
}

export const db = drizzle(databasePath, { relations });

// Embedded Turso is always available; DATABASE_PATH only changes its location.
export const isDbAvailable = () => true;

// Export schema for use elsewhere
export * from './schema';
