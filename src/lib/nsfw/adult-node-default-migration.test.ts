import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
    process.cwd(),
    'drizzle/20260717222500_adult_node_viewing_defaults/migration.sql',
);

async function runMigration(nodeIsNsfw: boolean) {
    const client = new Database(':memory:');
    await client.connect();
    const database = drizzle({ client });

    try {
        await database.run(sql.raw('CREATE TABLE nodes (is_nsfw integer NOT NULL)'));
        await database.run(sql.raw('CREATE TABLE users (id text PRIMARY KEY, nsfw_enabled integer NOT NULL, updated_at integer NOT NULL)'));
        await database.run(sql.raw(`INSERT INTO nodes (is_nsfw) VALUES (${nodeIsNsfw ? 1 : 0})`));
        await database.run(sql.raw("INSERT INTO users (id, nsfw_enabled, updated_at) VALUES ('legacy-user', 0, 0)"));

        const migration = await readFile(migrationPath, 'utf8');
        await database.run(sql.raw(migration));

        return await database.all<{ nsfwEnabled: number }>(sql.raw(
            "SELECT nsfw_enabled AS nsfwEnabled FROM users WHERE id = 'legacy-user'",
        ));
    } finally {
        await client.close();
    }
}

describe('adult-node viewing-default migration', () => {
    it('persists nsfwEnabled=true for every existing account on an adult node', async () => {
        await expect(runMigration(true)).resolves.toEqual([{ nsfwEnabled: 1 }]);
    });

    it('does not opt accounts in on a general-purpose node', async () => {
        await expect(runMigration(false)).resolves.toEqual([{ nsfwEnabled: 0 }]);
    });
});
