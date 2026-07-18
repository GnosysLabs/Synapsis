import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { getBackgroundHealth } from '@/lib/background/health';

const MIN_FREE_DISK_BYTES = 128 * 1024 * 1024;

export async function GET() {
    const checkedAt = new Date().toISOString();
    let databaseHealthy = false;
    let schemaCurrent = false;
    let diskHealthy = true;
    let freeDiskBytes: number | null = null;

    try {
        await db.run(sql`select 1`);
        databaseHealthy = true;
        const rows = await db.all<{ name: string }>(sql.raw(
            "select name from sqlite_master where type = 'table' and name = 'swarm_content_sync_states' limit 1",
        ));
        schemaCurrent = rows.length === 1;
    } catch {
        databaseHealthy = false;
    }

    const configuredPath = process.env.DATABASE_PATH || './data/synapsis.db';
    if (configuredPath !== ':memory:') {
        try {
            // DATABASE_PATH is an operator-provided runtime path, not a build-time
            // asset for Next.js to trace into the deployment bundle.
            const stats = await statfs(dirname(resolve(/* turbopackIgnore: true */ configuredPath)));
            freeDiskBytes = stats.bavail * stats.bsize;
            diskHealthy = freeDiskBytes >= MIN_FREE_DISK_BYTES;
        } catch {
            diskHealthy = false;
        }
    }

    const healthy = databaseHealthy && schemaCurrent && diskHealthy;
    return NextResponse.json({
        status: healthy ? 'healthy' : 'unhealthy',
        timestamp: checkedAt,
        service: 'synapsis',
        checks: {
            database: databaseHealthy,
            schema: schemaCurrent,
            disk: diskHealthy,
            freeDiskBytes,
            background: getBackgroundHealth(),
        },
    }, { status: healthy ? 200 : 503 });
}
