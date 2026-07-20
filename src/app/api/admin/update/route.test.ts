import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock('@/lib/auth/admin', () => ({
    requireAdmin: mocks.requireAdmin,
}));

vi.mock('node:fs/promises', () => ({
    writeFile: mocks.writeFile,
}));

import { POST } from './route';

describe('POST /api/admin/update', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('SYNAPSIS_UPDATE_REQUEST_PATH', '/tmp/synapsis-update-requested');
        mocks.requireAdmin.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
    });

    it('creates a one-shot update request for an administrator', async () => {
        const response = await POST();

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
            queued: true,
            alreadyQueued: false,
        });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/synapsis-update-requested',
            expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z\n$/),
            { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
    });

    it('treats an existing request as already queued', async () => {
        mocks.writeFile.mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));

        const response = await POST();

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            queued: true,
            alreadyQueued: true,
        });
    });

    it('rejects non-admin users without touching the request file', async () => {
        mocks.requireAdmin.mockRejectedValue(new Error('Admin required'));

        const response = await POST();

        expect(response.status).toBe(403);
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('reports installations that cannot expose the systemd trigger', async () => {
        mocks.writeFile.mockRejectedValue(Object.assign(new Error('read-only'), { code: 'EROFS' }));

        const response = await POST();

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
            error: 'Immediate updates are unavailable on this installation.',
        });
    });
});
