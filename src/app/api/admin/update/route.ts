import { writeFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';

const DEFAULT_UPDATE_REQUEST_PATH = '/var/lib/synapsis/update-requested';

function updateRequestPath(): string {
    return process.env.SYNAPSIS_UPDATE_REQUEST_PATH || DEFAULT_UPDATE_REQUEST_PATH;
}

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

export async function POST() {
    try {
        await requireAdmin();

        try {
            await writeFile(updateRequestPath(), `${new Date().toISOString()}\n`, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
        } catch (error) {
            if (errorCode(error) === 'EEXIST') {
                return NextResponse.json({
                    queued: true,
                    alreadyQueued: true,
                    message: 'An update check is already queued.',
                });
            }
            throw error;
        }

        return NextResponse.json({
            queued: true,
            alreadyQueued: false,
            message: 'Update check requested.',
        }, { status: 202 });
    } catch (error) {
        if (error instanceof Error && error.message === 'Admin required') {
            return NextResponse.json({ error: 'Admin required' }, { status: 403 });
        }

        if (['EACCES', 'ENOENT', 'EROFS'].includes(errorCode(error) || '')) {
            return NextResponse.json({
                error: 'Immediate updates are unavailable on this installation.',
            }, { status: 503 });
        }

        console.error('Request update error:', error);
        return NextResponse.json({ error: 'Failed to request an update check.' }, { status: 500 });
    }
}
