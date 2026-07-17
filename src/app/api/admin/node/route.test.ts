import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    findFirst: vi.fn(),
    findMany: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    requireAdmin: vi.fn(),
}));

vi.mock('@/db', () => ({
    db: {
        query: {
            nodes: {
                findFirst: mocks.findFirst,
                findMany: mocks.findMany,
            },
        },
        insert: mocks.insert,
        update: mocks.update,
    },
    nodes: { id: 'id' },
    users: { id: 'user-id' },
}));

vi.mock('@/lib/auth/admin', () => ({
    requireAdmin: mocks.requireAdmin,
}));

vi.mock('drizzle-orm', () => ({
    eq: vi.fn(() => 'node-id-match'),
    isNull: vi.fn(() => 'age-not-verified'),
}));

import { PATCH } from './route';

function createRequest(body: Record<string, unknown>) {
    return new Request('https://node.example/api/admin/node', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function mockNodeUpdate(result: Record<string, unknown>) {
    const returning = vi.fn().mockResolvedValue([result]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    mocks.update.mockReturnValue({ set });
    return { set, where, returning };
}

describe('PATCH /api/admin/node adult-only classification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXT_PUBLIC_NODE_DOMAIN = 'node.example';
        mocks.requireAdmin.mockResolvedValue(undefined);
        mocks.findMany.mockResolvedValue([]);
    });

    it('blocks an adult-only node from returning to general-audience status', async () => {
        mocks.findFirst.mockResolvedValue({ id: 'node-1', domain: 'node.example', isNsfw: true });

        const response = await PATCH(createRequest({ isNsfw: false }) as never);

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
            code: 'ADULT_ONLY_CLASSIFICATION_PERMANENT',
        });
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('requires the node domain before first enabling adult-only status', async () => {
        mocks.findFirst.mockResolvedValue({ id: 'node-1', domain: 'node.example', isNsfw: false });

        const response = await PATCH(createRequest({ isNsfw: true }) as never);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: 'ADULT_ONLY_CONFIRMATION_REQUIRED',
        });
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it('persists the permanent classification after a matching confirmation', async () => {
        const currentNode = { id: 'node-1', domain: 'node.example', isNsfw: false };
        mocks.findFirst.mockResolvedValue(currentNode);
        const update = mockNodeUpdate({ ...currentNode, isNsfw: true });

        const response = await PATCH(createRequest({
            isNsfw: true,
            nsfwConfirmationDomain: 'node.example',
        }) as never);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            node: { isNsfw: true },
        });
        expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ isNsfw: true }));
        expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ nsfwEnabled: false }));
        expect(update.where).toHaveBeenCalledWith('age-not-verified');
    });

    it('preserves adult-only status during unrelated settings updates', async () => {
        const currentNode = { id: 'node-1', domain: 'node.example', isNsfw: true };
        mocks.findFirst.mockResolvedValue(currentNode);
        const update = mockNodeUpdate({ ...currentNode, name: 'Renamed node' });

        const response = await PATCH(createRequest({ name: 'Renamed node' }) as never);

        expect(response.status).toBe(200);
        expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ isNsfw: true }));
    });
});
