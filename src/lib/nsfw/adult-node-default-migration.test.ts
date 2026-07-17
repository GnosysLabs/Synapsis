import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '@tursodatabase/database';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/tursodatabase/database';
import { describe, expect, it } from 'vitest';

const correctionMigrationPath = resolve(
    process.cwd(),
    'drizzle/20260717223800_require_adult_node_age_verification/migration.sql',
);

async function runCorrection({
    nodeIsNsfw,
    ageVerified,
    nsfwEnabled,
}: {
    nodeIsNsfw: boolean;
    ageVerified: boolean;
    nsfwEnabled: boolean;
}) {
    const client = new Database(':memory:');
    await client.connect();
    const database = drizzle({ client });

    try {
        await database.run(sql.raw('CREATE TABLE nodes (is_nsfw integer NOT NULL)'));
        await database.run(sql.raw('CREATE TABLE users (id text PRIMARY KEY, nsfw_enabled integer NOT NULL, age_verified_at integer, updated_at integer NOT NULL)'));
        await database.run(sql.raw(`INSERT INTO nodes (is_nsfw) VALUES (${nodeIsNsfw ? 1 : 0})`));
        await database.run(sql.raw(
            `INSERT INTO users (id, nsfw_enabled, age_verified_at, updated_at) VALUES ('legacy-user', ${nsfwEnabled ? 1 : 0}, ${ageVerified ? 1 : 'NULL'}, 0)`,
        ));

        const migration = await readFile(correctionMigrationPath, 'utf8');
        await database.run(sql.raw(migration));

        return await database.all<{ nsfwEnabled: number }>(sql.raw(
            "SELECT nsfw_enabled AS nsfwEnabled FROM users WHERE id = 'legacy-user'",
        ));
    } finally {
        await client.close();
    }
}

describe('adult-node age-verification correction migration', () => {
    it('undoes automatic opt-in for an existing account that never verified its age', async () => {
        await expect(runCorrection({
            nodeIsNsfw: true,
            ageVerified: false,
            nsfwEnabled: true,
        })).resolves.toEqual([{ nsfwEnabled: 0 }]);
    });

    it('preserves access for an account that explicitly verified its age', async () => {
        await expect(runCorrection({
            nodeIsNsfw: true,
            ageVerified: true,
            nsfwEnabled: true,
        })).resolves.toEqual([{ nsfwEnabled: 1 }]);
    });

    it('does not alter accounts on a general-purpose node', async () => {
        await expect(runCorrection({
            nodeIsNsfw: false,
            ageVerified: false,
            nsfwEnabled: false,
        })).resolves.toEqual([{ nsfwEnabled: 0 }]);
    });
});
